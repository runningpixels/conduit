// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Dictation's microphone side: records the default input device on its own
//! thread, folds it to 16 kHz mono as it arrives, and hands back a WAV file.
//!
//! Recording happens in Rust rather than in the webview because the three
//! webviews disagree on microphone permission (WebView2 prompts its own way,
//! WKWebView can prompt twice, WebKitGTK may simply refuse). `cpal` talks to
//! the platform's audio API directly; macOS still asks the user once, using
//! `NSMicrophoneUsageDescription` from `Info.plist`.
//!
//! 16 kHz mono is what speech models work at, and it keeps the upload small:
//! about 1.9 MB a minute as 16-bit WAV.

use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};

/// The rate recordings are kept at.
pub const TARGET_RATE: u32 = 16_000;

/// The longest recording kept. Five minutes is about 9.6 MB of WAV, inside
/// every provider's 25 MB upload limit and well inside OpenRouter's
/// 60-second processing limit.
pub const MAX_SECONDS: u32 = 300;

/// Shorter than this is a click, not speech.
const MIN_SECONDS: f32 = 0.3;

/// Below this peak (of full scale) nothing was said; sending it would only
/// cost money and come back empty, or invented.
const SILENCE_PEAK: f32 = 0.01;

/// Why a recording couldn't start or produced nothing worth sending.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecordError {
    NoMicrophone,
    /// The device refused to open; carries the platform's message.
    Device(String),
    /// Too short or silent.
    NothingHeard,
}

/// Turns the device's samples into 16 kHz as they arrive. Each output sample
/// is the mean of the input samples it covers, which is a rough low-pass
/// filter: enough to keep 48 kHz hiss from folding into the speech band.
#[derive(Debug, Clone)]
pub struct Downsampler {
    /// Input samples per output sample.
    step: f64,
    pos: f64,
    sum: f32,
    count: u32,
    last: f32,
    pub out: Vec<i16>,
    max_len: usize,
}

impl Downsampler {
    pub fn new(input_rate: u32, max_seconds: u32) -> Self {
        Downsampler {
            step: f64::from(input_rate.max(1)) / f64::from(TARGET_RATE),
            pos: 0.0,
            sum: 0.0,
            count: 0,
            last: 0.0,
            out: Vec::with_capacity((TARGET_RATE * 10) as usize),
            max_len: (TARGET_RATE * max_seconds) as usize,
        }
    }

    /// True once the recording has reached its length limit.
    pub fn full(&self) -> bool {
        self.out.len() >= self.max_len
    }

    /// Adds one mono input sample in -1..1.
    pub fn push(&mut self, sample: f32) {
        self.sum += sample;
        self.count += 1;
        self.last = sample;
        self.pos += 1.0;
        while self.pos >= self.step && !self.full() {
            let value = if self.count > 0 {
                self.sum / self.count as f32
            } else {
                // Upsampling: repeat the latest sample.
                self.last
            };
            self.out.push(to_i16(value));
            self.sum = 0.0;
            self.count = 0;
            self.pos -= self.step;
        }
    }
}

fn to_i16(sample: f32) -> i16 {
    (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).round() as i16
}

/// A 16-bit mono PCM WAV file.
pub fn wav_bytes(samples: &[i16], rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes()); // bytes per second
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

/// Whether a recording holds anything worth transcribing.
pub fn worth_sending(samples: &[i16]) -> bool {
    let long_enough = samples.len() as f32 >= MIN_SECONDS * TARGET_RATE as f32;
    let peak = samples.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);
    long_enough && f32::from(peak) >= SILENCE_PEAK * f32::from(i16::MAX)
}

/// Input level for the button, 0..1, from a block's RMS on a rough log scale
/// so normal speech sits in the middle rather than near zero.
pub fn level(rms: f32) -> f32 {
    if rms <= 0.0 {
        return 0.0;
    }
    let db = 20.0 * rms.log10();
    ((db + 60.0) / 60.0).clamp(0.0, 1.0)
}

/// A recording in progress. Dropping it stops the microphone and discards
/// the audio.
pub struct Recorder {
    stop: mpsc::Sender<()>,
    thread: Option<JoinHandle<Vec<i16>>>,
    started: Instant,
}

impl Recorder {
    /// Opens the default microphone and starts recording. `on_level` is
    /// called about every 80 ms with the input level; `on_full` once if the
    /// recording reaches [`MAX_SECONDS`].
    pub fn start(
        on_level: impl Fn(f32) + Send + 'static,
        on_full: impl Fn() + Send + 'static,
    ) -> Result<Recorder, RecordError> {
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), RecordError>>();
        // cpal streams can't move between threads on every platform, so one
        // thread opens, owns and closes the stream.
        let thread = std::thread::Builder::new()
            .name("dictation-mic".into())
            .spawn(move || {
                let samples = Arc::new(Mutex::new(None::<Downsampler>));
                let stream = match open_stream(samples.clone(), on_level, on_full) {
                    Ok(stream) => stream,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return Vec::new();
                    }
                };
                let _ = ready_tx.send(Ok(()));
                // A stop message, or the Recorder being dropped, ends it. The
                // timeout is a backstop in case neither ever comes.
                let _ = stop_rx.recv_timeout(Duration::from_secs(u64::from(MAX_SECONDS) + 60));
                drop(stream);
                let taken = samples.lock().ok().and_then(|mut s| s.take());
                taken.map(|d| d.out).unwrap_or_default()
            })
            .map_err(|e| RecordError::Device(e.to_string()))?;

        match ready_rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(())) => Ok(Recorder {
                stop: stop_tx,
                thread: Some(thread),
                started: Instant::now(),
            }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                let _ = stop_tx.send(());
                Err(RecordError::Device(
                    "the microphone did not start within 10 seconds".into(),
                ))
            }
        }
    }

    /// How long it has been recording.
    pub fn elapsed(&self) -> Duration {
        self.started.elapsed()
    }

    /// Stops the microphone and returns the recording as 16 kHz samples.
    pub fn finish(mut self) -> Vec<i16> {
        let _ = self.stop.send(());
        self.thread
            .take()
            .and_then(|t| t.join().ok())
            .unwrap_or_default()
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        let _ = self.stop.send(());
    }
}

fn open_stream(
    samples: Arc<Mutex<Option<Downsampler>>>,
    on_level: impl Fn(f32) + Send + 'static,
    on_full: impl Fn() + Send + 'static,
) -> Result<cpal::Stream, RecordError> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or(RecordError::NoMicrophone)?;
    let supported = device
        .default_input_config()
        .map_err(|e| RecordError::Device(e.to_string()))?;
    let config: cpal::StreamConfig = supported.into();
    let channels = usize::from(config.channels.max(1));
    if let Ok(mut s) = samples.lock() {
        *s = Some(Downsampler::new(config.sample_rate, MAX_SECONDS));
    }
    let sink = Sink {
        samples,
        channels,
        on_level: Box::new(on_level),
        on_full: Box::new(on_full),
        last_level: Instant::now(),
        full_sent: false,
        sum_sq: 0.0,
        n: 0,
    };
    let stream = match supported.sample_format() {
        SampleFormat::F32 => build::<f32>(&device, &config, sink),
        SampleFormat::I16 => build::<i16>(&device, &config, sink),
        SampleFormat::U16 => build::<u16>(&device, &config, sink),
        SampleFormat::I32 => build::<i32>(&device, &config, sink),
        SampleFormat::I8 => build::<i8>(&device, &config, sink),
        SampleFormat::U8 => build::<u8>(&device, &config, sink),
        other => Err(RecordError::Device(format!(
            "unsupported microphone sample format {other}"
        ))),
    }?;
    stream
        .play()
        .map_err(|e| RecordError::Device(e.to_string()))?;
    Ok(stream)
}

/// What the audio callback writes into.
struct Sink {
    samples: Arc<Mutex<Option<Downsampler>>>,
    channels: usize,
    on_level: Box<dyn Fn(f32) + Send>,
    on_full: Box<dyn Fn() + Send>,
    last_level: Instant,
    full_sent: bool,
    sum_sq: f32,
    n: u32,
}

impl Sink {
    fn write<T>(&mut self, data: &[T])
    where
        T: Sample,
        f32: FromSample<T>,
    {
        let mut full = false;
        if let Ok(mut guard) = self.samples.lock() {
            if let Some(down) = guard.as_mut() {
                for frame in data.chunks(self.channels) {
                    let mono = frame.iter().map(|s| f32::from_sample(*s)).sum::<f32>()
                        / frame.len() as f32;
                    self.sum_sq += mono * mono;
                    self.n += 1;
                    down.push(mono);
                }
                full = down.full();
            }
        }
        if self.last_level.elapsed() >= Duration::from_millis(80) && self.n > 0 {
            (self.on_level)(level((self.sum_sq / self.n as f32).sqrt()));
            self.sum_sq = 0.0;
            self.n = 0;
            self.last_level = Instant::now();
        }
        if full && !self.full_sent {
            self.full_sent = true;
            (self.on_full)();
        }
    }
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut sink: Sink,
) -> Result<cpal::Stream, RecordError>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    device
        .build_input_stream(
            *config,
            move |data: &[T], _: &cpal::InputCallbackInfo| sink.write(data),
            |e| tracing::warn!("dictation microphone stream error: {e}"),
            None,
        )
        .map_err(|e| RecordError::Device(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, seconds: f32, hz: f32, amp: f32) -> Vec<f32> {
        (0..(rate as f32 * seconds) as usize)
            .map(|i| amp * (2.0 * std::f32::consts::PI * hz * i as f32 / rate as f32).sin())
            .collect()
    }

    #[test]
    fn downsamples_common_rates_to_16k() {
        for rate in [48_000u32, 44_100, 16_000, 8_000] {
            let mut d = Downsampler::new(rate, MAX_SECONDS);
            for s in tone(rate, 1.0, 440.0, 0.5) {
                d.push(s);
            }
            let len = d.out.len() as i64;
            assert!((len - 16_000).abs() <= 2, "{rate} Hz gave {len} samples");
        }
    }

    #[test]
    fn keeps_speech_and_damps_what_it_cannot_hold() {
        let peak = |hz: f32| {
            let mut d = Downsampler::new(48_000, MAX_SECONDS);
            for s in tone(48_000, 0.5, hz, 0.5) {
                d.push(s);
            }
            d.out.iter().map(|s| s.unsigned_abs()).max().unwrap()
        };
        // A voice-band tone keeps nearly all of its level...
        assert!(peak(300.0) > 15_000);
        // ...while 16 kHz hiss, which would fold into the speech band, mostly goes.
        assert!(peak(16_000.0) < 2_000);
    }

    #[test]
    fn stops_at_the_length_limit() {
        let mut d = Downsampler::new(16_000, 1);
        for _ in 0..40_000 {
            d.push(0.1);
        }
        assert_eq!(d.out.len(), 16_000);
        assert!(d.full());
    }

    #[test]
    fn writes_a_valid_wav_header() {
        let wav = wav_bytes(&[0, 1, -1, i16::MAX], 16_000);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()), 36 + 8);
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16_000);
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 8);
        assert_eq!(wav.len(), 52);
        assert_eq!(i16::from_le_bytes([wav[50], wav[51]]), i16::MAX);
    }

    #[test]
    fn refuses_clicks_and_silence() {
        let speech: Vec<i16> = (0..16_000)
            .map(|i| if i % 2 == 0 { 4_000 } else { -4_000 })
            .collect();
        assert!(worth_sending(&speech));
        assert!(!worth_sending(&speech[..2_000]), "a click");
        assert!(!worth_sending(&vec![50i16; 16_000]), "room noise");
        assert!(!worth_sending(&[]));
    }

    #[test]
    fn level_puts_speech_mid_scale() {
        assert_eq!(level(0.0), 0.0);
        assert_eq!(level(1.0), 1.0);
        let speech = level(0.05);
        assert!(speech > 0.3 && speech < 0.8, "{speech}");
    }
}
