//! When a workflow runs on its own: every day or on weekdays at a time, or
//! every few hours.
//!
//! Times are wall-clock times in the user's zone: "08:00" is 08:00 before and
//! after a daylight-saving change. [`ScheduleSpec::next_after`] is generic over
//! the zone so it can be tested with fixed offsets; the scheduler passes
//! `chrono::Local`. A time that doesn't exist that day (the hour skipped when
//! clocks go forward) runs at the first minute that does; a time that happens
//! twice (clocks go back) runs once, the first time.

use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveTime, TimeZone, Weekday};
use serde::{Deserialize, Serialize};

/// Longest gap an "every N hours" schedule may have.
pub const MAX_INTERVAL_HOURS: u32 = 24;

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
            Self::Interval { hours } => {
                if (1..=MAX_INTERVAL_HOURS).contains(hours) {
                    Ok(())
                } else {
                    Err(format!("Choose between 1 and {MAX_INTERVAL_HOURS} hours."))
                }
            }
        }
    }

    /// The first time strictly after `after` this schedule is due.
    pub fn next_after<Tz: TimeZone>(&self, after: &DateTime<Tz>) -> Result<DateTime<Tz>, String> {
        match self {
            Self::Interval { hours } => {
                self.validate()?;
                Ok(after.clone() + Duration::hours(i64::from(*hours)))
            }
            Self::Trigger => Ok(after.clone() + Duration::minutes(1)),
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
                            return Ok(candidate);
                        }
                    }
                    day = day.succ_opt().ok_or("The date is out of range.")?;
                }
                Err("No time found for this schedule.".to_string())
            }
        }
    }
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
            spec.next_after(&at("2026-09-29T07:59:00+02:00")).unwrap(),
            at("2026-09-29T08:00:00+02:00")
        );
        // Exactly at the time counts as passed: the next one is tomorrow.
        assert_eq!(
            spec.next_after(&at("2026-09-29T08:00:00+02:00")).unwrap(),
            at("2026-09-30T08:00:00+02:00")
        );
        assert_eq!(
            spec.next_after(&at("2026-09-29T21:00:00+02:00")).unwrap(),
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
            spec.next_after(&at("2026-10-02T06:00:00-05:00")).unwrap(),
            at("2026-10-02T07:30:00-05:00")
        );
        assert_eq!(
            spec.next_after(&at("2026-10-02T09:00:00-05:00")).unwrap(),
            at("2026-10-05T07:30:00-05:00")
        );
        assert_eq!(
            spec.next_after(&at("2026-10-03T12:00:00-05:00")).unwrap(),
            at("2026-10-05T07:30:00-05:00")
        );
    }

    #[test]
    fn interval_counts_from_the_given_time() {
        let spec = ScheduleSpec::Interval { hours: 6 };
        assert_eq!(
            spec.next_after(&at("2026-09-29T22:15:00+00:00")).unwrap(),
            at("2026-09-30T04:15:00+00:00")
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
