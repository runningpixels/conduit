//! An installed app's icon files, from the PNGs the page draws (it has the
//! fonts the app tile uses, colour emoji included).
//!
//! Both containers hold the PNGs as they are, so no image decoding happens
//! here: `.ico` (Windows, PNG entries since Vista) and `.icns` (macOS, PNG
//! chunks since 10.7). Linux uses the 256 px PNG directly.

use base64::Engine as _;
use provider_core::schema::AppIconImage;

/// The sizes the page sends. 256 is required (every OS uses it).
pub const ICON_SIZES: [u32; 6] = [16, 32, 48, 128, 256, 512];
const MAX_PNG_BYTES: usize = 2 * 1024 * 1024;
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n'];

/// A checked icon PNG.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IconPng {
    pub size: u32,
    pub bytes: Vec<u8>,
}

/// The width and height a PNG says it has, or `None` if it isn't one.
pub fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || bytes[..8] != PNG_SIGNATURE || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((width, height))
}

/// Decode and check what the page sent: known sizes only, each a square PNG
/// of the size it claims, one per size, 256 present.
pub fn validate(images: &[AppIconImage]) -> Result<Vec<IconPng>, String> {
    let mut out: Vec<IconPng> = Vec::new();
    for image in images {
        if !ICON_SIZES.contains(&image.size) {
            return Err(format!("unsupported icon size {}", image.size));
        }
        if out.iter().any(|i| i.size == image.size) {
            return Err(format!("icon size {} sent twice", image.size));
        }
        if image.png_base64.len() > MAX_PNG_BYTES * 4 / 3 + 4 {
            return Err(format!("the {} px icon is too large", image.size));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(image.png_base64.trim())
            .map_err(|_| format!("the {} px icon isn't base64", image.size))?;
        match png_dimensions(&bytes) {
            Some((w, h)) if w == image.size && h == image.size => {}
            Some((w, h)) => return Err(format!("the {} px icon is {w}×{h}", image.size)),
            None => return Err(format!("the {} px icon isn't a PNG", image.size)),
        }
        out.push(IconPng {
            size: image.size,
            bytes,
        });
    }
    if !out.iter().any(|i| i.size == 256) {
        return Err("the 256 px icon is missing".into());
    }
    out.sort_by_key(|i| i.size);
    Ok(out)
}

/// The PNG of one size, if sent.
pub fn of_size(icons: &[IconPng], size: u32) -> Option<&IconPng> {
    icons.iter().find(|i| i.size == size)
}

/// A Windows `.ico` holding the PNGs up to 256 px (the format's limit).
pub fn ico(icons: &[IconPng]) -> Vec<u8> {
    let entries: Vec<&IconPng> = icons.iter().filter(|i| i.size <= 256).collect();
    let count = entries.len() as u16;
    let mut out = Vec::new();
    out.extend_from_slice(&0u16.to_le_bytes()); // reserved
    out.extend_from_slice(&1u16.to_le_bytes()); // type: icon
    out.extend_from_slice(&count.to_le_bytes());
    let mut offset = 6 + 16 * entries.len() as u32;
    for icon in &entries {
        // 0 means 256 in the one-byte width and height fields.
        let dim = if icon.size >= 256 { 0 } else { icon.size as u8 };
        out.push(dim);
        out.push(dim);
        out.push(0); // palette colours
        out.push(0); // reserved
        out.extend_from_slice(&1u16.to_le_bytes()); // planes
        out.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
        out.extend_from_slice(&(icon.bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        offset += icon.bytes.len() as u32;
    }
    for icon in &entries {
        out.extend_from_slice(&icon.bytes);
    }
    out
}

/// The `.icns` chunk type for a PNG of this size.
fn icns_type(size: u32) -> Option<&'static [u8; 4]> {
    match size {
        16 => Some(b"icp4"),
        32 => Some(b"icp5"),
        128 => Some(b"ic07"),
        256 => Some(b"ic08"),
        512 => Some(b"ic09"),
        _ => None,
    }
}

/// A macOS `.icns` of the PNG chunks it has a type for.
pub fn icns(icons: &[IconPng]) -> Vec<u8> {
    let mut body = Vec::new();
    for icon in icons {
        let Some(kind) = icns_type(icon.size) else {
            continue;
        };
        body.extend_from_slice(kind);
        body.extend_from_slice(&((icon.bytes.len() + 8) as u32).to_be_bytes());
        body.extend_from_slice(&icon.bytes);
    }
    let mut out = Vec::with_capacity(body.len() + 8);
    out.extend_from_slice(b"icns");
    out.extend_from_slice(&((body.len() + 8) as u32).to_be_bytes());
    out.extend_from_slice(&body);
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A minimal PNG header of the given size (enough for every check here).
    pub(crate) fn fake_png(size: u32) -> Vec<u8> {
        let mut bytes = PNG_SIGNATURE.to_vec();
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&size.to_be_bytes());
        bytes.extend_from_slice(&size.to_be_bytes());
        bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
        bytes
    }

    pub(crate) fn image(size: u32) -> AppIconImage {
        AppIconImage {
            size,
            png_base64: base64::engine::general_purpose::STANDARD.encode(fake_png(size)),
        }
    }

    #[test]
    fn accepts_the_sizes_the_page_sends() {
        let images: Vec<_> = ICON_SIZES.iter().map(|s| image(*s)).collect();
        let icons = validate(&images).unwrap();
        assert_eq!(icons.len(), ICON_SIZES.len());
        assert_eq!(icons[0].size, 16);
    }

    #[test]
    fn refuses_bad_icons() {
        assert!(validate(&[image(32)]).unwrap_err().contains("256"));
        assert!(validate(&[image(256), image(256)]).is_err());
        assert!(validate(&[image(100)]).is_err());
        let mut lying = image(256);
        lying.png_base64 = base64::engine::general_purpose::STANDARD.encode(fake_png(128));
        assert!(validate(&[lying]).unwrap_err().contains("128"));
        let not_png = AppIconImage {
            size: 256,
            png_base64: base64::engine::general_purpose::STANDARD
                .encode(b"GIF89a.................."),
        };
        assert!(validate(&[not_png]).unwrap_err().contains("PNG"));
    }

    #[test]
    fn ico_directory_points_at_each_png() {
        let icons = validate(&[image(16), image(256), image(512)]).unwrap();
        let file = ico(&icons);
        assert_eq!(&file[0..6], &[0, 0, 1, 0, 2, 0], "512 is left out");
        // Entry 1: 16 px. Entry 2: 256 px, written as 0.
        assert_eq!(file[6], 16);
        assert_eq!(file[22], 0);
        let offset = u32::from_le_bytes(file[18..22].try_into().unwrap()) as usize;
        assert_eq!(png_dimensions(&file[offset..]), Some((16, 16)));
        let offset2 = u32::from_le_bytes(file[34..38].try_into().unwrap()) as usize;
        assert_eq!(png_dimensions(&file[offset2..]), Some((256, 256)));
    }

    #[test]
    fn icns_length_fields_add_up() {
        let icons = validate(&[image(48), image(256), image(512)]).unwrap();
        let file = icns(&icons);
        assert_eq!(&file[0..4], b"icns");
        let total = u32::from_be_bytes(file[4..8].try_into().unwrap()) as usize;
        assert_eq!(total, file.len());
        // 48 has no type: first chunk is ic08.
        assert_eq!(&file[8..12], b"ic08");
        let first = u32::from_be_bytes(file[12..16].try_into().unwrap()) as usize;
        assert_eq!(&file[8 + first..12 + first], b"ic09");
    }
}
