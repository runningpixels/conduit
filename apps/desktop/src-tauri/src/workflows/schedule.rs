//! When a workflow runs on its own: every day, on weekdays or on chosen days
//! of the week at a time, on a day of the month, every few hours, or once.
//!
//! Times are wall-clock times in the user's zone: "08:00" is 08:00 before and
//! after a daylight-saving change. [`ScheduleSpec::next_after`] is generic over
//! the zone so it can be tested with fixed offsets; the scheduler passes
//! `chrono::Local`. A time that doesn't exist that day (the hour skipped when
//! clocks go forward) runs at the first minute that does; a time that happens
//! twice (clocks go back) runs once, the first time.

use chrono::{
    DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone,
    Weekday,
};
use serde::{Deserialize, Serialize};

/// Longest gap an "every N hours" schedule may have.
pub const MAX_INTERVAL_HOURS: u32 = 24;

/// A day of the week, written `mon` .. `sun` in a stored schedule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Day {
    Mon,
    Tue,
    Wed,
    Thu,
    Fri,
    Sat,
    Sun,
}

impl Day {
    fn weekday(self) -> Weekday {
        match self {
            Self::Mon => Weekday::Mon,
            Self::Tue => Weekday::Tue,
            Self::Wed => Weekday::Wed,
            Self::Thu => Weekday::Thu,
            Self::Fri => Weekday::Fri,
            Self::Sat => Weekday::Sat,
            Self::Sun => Weekday::Sun,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ScheduleSpec {
    /// Every day at `time` (`HH:MM`, 24-hour, local).
    Daily { time: String },
    /// Monday to Friday at `time`.
    Weekdays { time: String },
    /// On the listed days of the week at `time`; at least one day, repeats ignored.
    Weekly { days: Vec<Day>, time: String },
    /// On day `day` (1-31) of each month at `time`. A month without that day
    /// runs on its last day instead.
    Monthly { day: u8, time: String },
    /// One time only, `at` (`YYYY-MM-DDTHH:MM`, local). After it has passed
    /// there is no next time ([`ScheduleSpec::next_after`] gives `None`).
    Once { at: String },
    /// Every `hours` hours from the last run.
    Interval { hours: u32 },
    /// Whenever the workflow's trigger (a feed or its folder) has something
    /// new. It is looked at about once a minute here; the workflow's own
    /// trigger says how often (see `triggers`), which the scheduler reads.
    Trigger,
}

impl ScheduleSpec {
    /// Why this schedule can't be used, in plain English, if it can't.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Daily { time } | Self::Weekdays { time } => parse_time(time).map(|_| ()),
            Self::Trigger => Ok(()),
            Self::Weekly { days, time } => {
                if days.is_empty() {
                    return Err("Choose at least one day of the week.".to_string());
                }
                parse_time(time).map(|_| ())
            }
            Self::Monthly { day, time } => {
                if !(1..=31).contains(day) {
                    return Err("Choose a day of the month between 1 and 31.".to_string());
                }
                parse_time(time).map(|_| ())
            }
            Self::Once { at } => parse_once(at).map(|_| ()),
            Self::Interval { hours } => {
                if (1..=MAX_INTERVAL_HOURS).contains(hours) {
                    Ok(())
                } else {
                    Err(format!("Choose between 1 and {MAX_INTERVAL_HOURS} hours."))
                }
            }
        }
    }

    /// The first time strictly after `after` this schedule is due, or `None`
    /// when it will never be due again (a `Once` whose time has passed).
    pub fn next_after<Tz: TimeZone>(
        &self,
        after: &DateTime<Tz>,
    ) -> Result<Option<DateTime<Tz>>, String> {
        match self {
            Self::Interval { hours } => {
                self.validate()?;
                Ok(Some(after.clone() + Duration::hours(i64::from(*hours))))
            }
            Self::Trigger => Ok(Some(after.clone() + Duration::minutes(1))),
            Self::Once { at } => {
                let naive = parse_once(at)?;
                let when = at_local(&after.timezone(), naive.date(), naive.time());
                Ok((when > *after).then_some(when))
            }
            Self::Weekly { days, time } => {
                self.validate()?;
                let at = parse_time(time)?;
                let tz = after.timezone();
                let mut day = after.date_naive();
                for _ in 0..8 {
                    if days.iter().any(|d| d.weekday() == day.weekday()) {
                        let candidate = at_local(&tz, day, at);
                        if candidate > *after {
                            return Ok(Some(candidate));
                        }
                    }
                    day = day.succ_opt().ok_or("The date is out of range.")?;
                }
                Err("No time found for this schedule.".to_string())
            }
            Self::Monthly { day, time } => {
                self.validate()?;
                let at = parse_time(time)?;
                let tz = after.timezone();
                let (mut year, mut month) = (after.year(), after.month());
                // This month, then up to a year ahead (the day always exists
                // once clamped, so the next month at the latest).
                for _ in 0..14 {
                    let last = last_day_of_month(year, month)?;
                    let date = NaiveDate::from_ymd_opt(year, month, u32::from(*day).min(last))
                        .ok_or("The date is out of range.")?;
                    let candidate = at_local(&tz, date, at);
                    if candidate > *after {
                        return Ok(Some(candidate));
                    }
                    if month == 12 {
                        year += 1;
                        month = 1;
                    } else {
                        month += 1;
                    }
                }
                Err("No time found for this schedule.".to_string())
            }
            Self::Daily { time } | Self::Weekdays { time } => {
                let at = parse_time(time)?;
                let weekdays_only = matches!(self, Self::Weekdays { .. });
                let tz = after.timezone();
                let mut day = after.date_naive();
                // At most a week ahead (a weekend, plus today already passed).
                for _ in 0..8 {
                    let is_weekend = matches!(day.weekday(), Weekday::Sat | Weekday::Sun);
                    if !(weekdays_only && is_weekend) {
                        let candidate = at_local(&tz, day, at);
                        if candidate > *after {
                            return Ok(Some(candidate));
                        }
                    }
                    day = day.succ_opt().ok_or("The date is out of range.")?;
                }
                Err("No time found for this schedule.".to_string())
            }
        }
    }
}

/// `YYYY-MM-DDTHH:MM`, local, for a one-time schedule.
fn parse_once(at: &str) -> Result<NaiveDateTime, String> {
    NaiveDateTime::parse_from_str(at.trim(), "%Y-%m-%dT%H:%M")
        .map_err(|_| format!("\"{at}\" isn't a date and time like 2026-12-24T09:30."))
}

/// How many days `month` of `year` has.
fn last_day_of_month(year: i32, month: u32) -> Result<u32, String> {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    NaiveDate::from_ymd_opt(next_year, next_month, 1)
        .and_then(|first| first.pred_opt())
        .map(|last| last.day())
        .ok_or_else(|| "The date is out of range.".to_string())
}

/// `HH:MM`, 24-hour.
fn parse_time(time: &str) -> Result<NaiveTime, String> {
    NaiveTime::parse_from_str(time.trim(), "%H:%M")
        .map_err(|_| format!("\"{time}\" isn't a time like 08:30."))
}

/// `time` on `day` in `tz`. A skipped time moves forward to the first minute
/// that exists; a repeated one takes its first occurrence.
fn at_local<Tz: TimeZone>(tz: &Tz, day: NaiveDate, time: NaiveTime) -> DateTime<Tz> {
    let mut naive = day.and_time(time);
    for _ in 0..=180 {
        match tz.from_local_datetime(&naive) {
            LocalResult::Single(t) => return t,
            LocalResult::Ambiguous(first, _) => return first,
            LocalResult::None => naive += Duration::minutes(1),
        }
    }
    // No zone skips three hours; fall back to reading it as UTC.
    tz.from_utc_datetime(&day.and_time(time))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn at(s: &str) -> DateTime<FixedOffset> {
        DateTime::parse_from_rfc3339(s).unwrap()
    }

    #[test]
    fn daily_is_later_today_or_tomorrow() {
        let spec = ScheduleSpec::Daily {
            time: "08:00".into(),
        };
        assert_eq!(
            spec.next_after(&at("2026-09-29T07:59:00+02:00"))
                .unwrap()
                .unwrap(),
            at("2026-09-29T08:00:00+02:00")
        );
        // Exactly at the time counts as passed: the next one is tomorrow.
        assert_eq!(
            spec.next_after(&at("2026-09-29T08:00:00+02:00"))
                .unwrap()
                .unwrap(),
            at("2026-09-30T08:00:00+02:00")
        );
        assert_eq!(
            spec.next_after(&at("2026-09-29T21:00:00+02:00"))
                .unwrap()
                .unwrap(),
            at("2026-09-30T08:00:00+02:00")
        );
    }

    #[test]
    fn weekdays_skip_the_weekend() {
        let spec = ScheduleSpec::Weekdays {
            time: "07:30".into(),
        };
        // 2026-10-02 is a Friday.
        assert_eq!(
            spec.next_after(&at("2026-10-02T06:00:00-05:00"))
                .unwrap()
                .unwrap(),
            at("2026-10-02T07:30:00-05:00")
        );
        assert_eq!(
            spec.next_after(&at("2026-10-02T09:00:00-05:00"))
                .unwrap()
                .unwrap(),
            at("2026-10-05T07:30:00-05:00")
        );
        assert_eq!(
            spec.next_after(&at("2026-10-03T12:00:00-05:00"))
                .unwrap()
                .unwrap(),
            at("2026-10-05T07:30:00-05:00")
        );
    }

    #[test]
    fn interval_counts_from_the_given_time() {
        let spec = ScheduleSpec::Interval { hours: 6 };
        assert_eq!(
            spec.next_after(&at("2026-09-29T22:15:00+00:00"))
                .unwrap()
                .unwrap(),
            at("2026-09-30T04:15:00+00:00")
        );
    }

    fn next(spec: &ScheduleSpec, after: &str) -> Option<DateTime<FixedOffset>> {
        spec.next_after(&at(after)).unwrap()
    }

    #[test]
    fn weekly_picks_the_next_listed_day() {
        // 2026-10-05 is a Monday.
        let spec = ScheduleSpec::Weekly {
            days: vec![Day::Wed, Day::Mon, Day::Mon],
            time: "09:00".into(),
        };
        assert_eq!(
            next(&spec, "2026-10-05T08:00:00+02:00"),
            Some(at("2026-10-05T09:00:00+02:00"))
        );
        assert_eq!(
            next(&spec, "2026-10-05T09:00:00+02:00"),
            Some(at("2026-10-07T09:00:00+02:00"))
        );
        // After Wednesday's run, the next Monday.
        assert_eq!(
            next(&spec, "2026-10-07T10:00:00+02:00"),
            Some(at("2026-10-12T09:00:00+02:00"))
        );
        // A single day means a week later when today's time has passed.
        let sunday = ScheduleSpec::Weekly {
            days: vec![Day::Sun],
            time: "09:00".into(),
        };
        assert_eq!(
            next(&sunday, "2026-10-04T09:00:00+02:00"),
            Some(at("2026-10-11T09:00:00+02:00"))
        );
    }

    #[test]
    fn monthly_clamps_to_the_last_day_of_a_short_month() {
        let spec = ScheduleSpec::Monthly {
            day: 31,
            time: "07:00".into(),
        };
        assert_eq!(
            next(&spec, "2026-01-31T06:00:00+00:00"),
            Some(at("2026-01-31T07:00:00+00:00"))
        );
        // February 2026 has 28 days.
        assert_eq!(
            next(&spec, "2026-01-31T07:00:00+00:00"),
            Some(at("2026-02-28T07:00:00+00:00"))
        );
        // A leap year's February has 29.
        assert_eq!(
            next(&spec, "2028-01-31T08:00:00+00:00"),
            Some(at("2028-02-29T07:00:00+00:00"))
        );
        // The year turns over.
        let fifteenth = ScheduleSpec::Monthly {
            day: 15,
            time: "12:00".into(),
        };
        assert_eq!(
            next(&fifteenth, "2026-12-20T00:00:00+00:00"),
            Some(at("2027-01-15T12:00:00+00:00"))
        );
    }

    #[test]
    fn once_runs_a_single_time_then_has_no_next() {
        let spec = ScheduleSpec::Once {
            at: "2026-12-24T09:30".into(),
        };
        assert_eq!(
            next(&spec, "2026-12-01T00:00:00+01:00"),
            Some(at("2026-12-24T09:30:00+01:00"))
        );
        assert_eq!(next(&spec, "2026-12-24T09:30:00+01:00"), None);
        assert_eq!(next(&spec, "2027-01-01T00:00:00+01:00"), None);
        assert!(ScheduleSpec::Once {
            at: "tomorrow".into()
        }
        .validate()
        .is_err());
    }

    #[test]
    fn new_kinds_keep_daylight_saving_rules() {
        /// A zone like Berlin in spring 2026: +01:00 until 2026-03-29 02:00,
        /// then +02:00, so local 02:00-03:00 that day doesn't exist.
        #[derive(Clone, Copy, Debug)]
        struct Spring;
        impl Spring {
            fn winter() -> FixedOffset {
                FixedOffset::east_opt(3600).unwrap()
            }
            fn summer() -> FixedOffset {
                FixedOffset::east_opt(7200).unwrap()
            }
        }
        impl TimeZone for Spring {
            type Offset = FixedOffset;
            fn from_offset(_: &FixedOffset) -> Self {
                Spring
            }
            fn offset_from_local_date(&self, d: &NaiveDate) -> LocalResult<FixedOffset> {
                self.offset_from_local_datetime(&d.and_hms_opt(12, 0, 0).unwrap())
            }
            fn offset_from_local_datetime(&self, l: &NaiveDateTime) -> LocalResult<FixedOffset> {
                let jump = NaiveDate::from_ymd_opt(2026, 3, 29).unwrap();
                let gap_start = jump.and_hms_opt(2, 0, 0).unwrap();
                let gap_end = jump.and_hms_opt(3, 0, 0).unwrap();
                if *l < gap_start {
                    LocalResult::Single(Self::winter())
                } else if *l < gap_end {
                    LocalResult::None
                } else {
                    LocalResult::Single(Self::summer())
                }
            }
            fn offset_from_utc_date(&self, d: &NaiveDate) -> FixedOffset {
                self.offset_from_utc_datetime(&d.and_hms_opt(12, 0, 0).unwrap())
            }
            fn offset_from_utc_datetime(&self, u: &NaiveDateTime) -> FixedOffset {
                let jump = NaiveDate::from_ymd_opt(2026, 3, 29)
                    .unwrap()
                    .and_hms_opt(1, 0, 0)
                    .unwrap();
                if *u < jump {
                    Self::winter()
                } else {
                    Self::summer()
                }
            }
        }
        let before = Spring.from_utc_datetime(
            &NaiveDate::from_ymd_opt(2026, 3, 28)
                .unwrap()
                .and_hms_opt(12, 0, 0)
                .unwrap(),
        );
        let monthly = ScheduleSpec::Monthly {
            day: 29,
            time: "02:30".into(),
        };
        // 02:30 doesn't exist; it runs at 03:00, the first minute that does.
        let got = monthly.next_after(&before).unwrap().unwrap();
        assert_eq!(got.format("%Y-%m-%d %H:%M").to_string(), "2026-03-29 03:00");
        let once = ScheduleSpec::Once {
            at: "2026-03-29T02:30".into(),
        };
        let got = once.next_after(&before).unwrap().unwrap();
        assert_eq!(got.format("%H:%M").to_string(), "03:00");
        let weekly = ScheduleSpec::Weekly {
            days: vec![Day::Sun],
            time: "02:30".into(),
        };
        let got = weekly.next_after(&before).unwrap().unwrap();
        assert_eq!(got.format("%Y-%m-%d %H:%M").to_string(), "2026-03-29 03:00");
    }

    #[test]
    fn new_kinds_are_validated_and_round_trip() {
        assert!(ScheduleSpec::Weekly {
            days: vec![],
            time: "09:00".into()
        }
        .validate()
        .is_err());
        assert!(ScheduleSpec::Monthly {
            day: 0,
            time: "09:00".into()
        }
        .validate()
        .is_err());
        assert!(ScheduleSpec::Monthly {
            day: 32,
            time: "09:00".into()
        }
        .validate()
        .is_err());
        let weekly = ScheduleSpec::Weekly {
            days: vec![Day::Mon, Day::Sun],
            time: "09:00".into(),
        };
        let json = serde_json::to_value(&weekly).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "weekly", "days": ["mon", "sun"], "time": "09:00" })
        );
        assert_eq!(
            serde_json::from_value::<ScheduleSpec>(json).unwrap(),
            weekly
        );
        assert_eq!(
            serde_json::to_value(ScheduleSpec::Monthly {
                day: 5,
                time: "08:00".into()
            })
            .unwrap(),
            serde_json::json!({ "kind": "monthly", "day": 5, "time": "08:00" })
        );
        assert_eq!(
            serde_json::to_value(ScheduleSpec::Once {
                at: "2026-12-24T09:30".into()
            })
            .unwrap(),
            serde_json::json!({ "kind": "once", "at": "2026-12-24T09:30" })
        );
    }

    #[test]
    fn bad_specs_are_refused_in_plain_english() {
        assert!(ScheduleSpec::Daily {
            time: "25:00".into()
        }
        .validate()
        .unwrap_err()
        .contains("08:30"));
        assert!(ScheduleSpec::Daily { time: "8am".into() }
            .validate()
            .is_err());
        assert!(ScheduleSpec::Interval { hours: 0 }.validate().is_err());
        assert!(ScheduleSpec::Interval { hours: 25 }.validate().is_err());
        assert!(ScheduleSpec::Interval { hours: 24 }.validate().is_ok());
    }

    #[test]
    fn specs_round_trip_as_tagged_json() {
        let spec = ScheduleSpec::Weekdays {
            time: "07:30".into(),
        };
        let json = serde_json::to_value(&spec).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "kind": "weekdays", "time": "07:30" })
        );
        assert_eq!(serde_json::from_value::<ScheduleSpec>(json).unwrap(), spec);
        assert_eq!(
            serde_json::to_value(ScheduleSpec::Interval { hours: 4 }).unwrap(),
            serde_json::json!({ "kind": "interval", "hours": 4 })
        );
        assert_eq!(
            serde_json::to_value(ScheduleSpec::Trigger).unwrap(),
            serde_json::json!({ "kind": "trigger" })
        );
        assert_eq!(
            serde_json::from_value::<ScheduleSpec>(serde_json::json!({ "kind": "trigger" }))
                .unwrap(),
            ScheduleSpec::Trigger
        );
    }
}
