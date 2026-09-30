use std::path::Path;

/// Return the episode number prefix from a document name, padded to four digits.
/// Numbers longer than four digits are kept intact.
pub fn episode_number(document: &Path) -> Option<String> {
    let stem = document.file_stem()?.to_str()?.trim_start();
    let digits: String = stem.chars().take_while(char::is_ascii_digit).collect();
    (!digits.is_empty()).then(|| format!("{digits:0>4}"))
}

#[cfg(test)]
mod tests {
    use super::episode_number;
    use std::path::Path;

    #[test]
    fn pads_short_episode_numbers_without_truncating_long_ones() {
        for (document, expected) in [
            ("01 集名.md", Some("0001")),
            ("episodes/2 集名.md", Some("0002")),
            ("0123 集名.md", Some("0123")),
            ("10000 集名.md", Some("10000")),
            ("episodes/集名.md", None),
        ] {
            assert_eq!(
                episode_number(Path::new(document)).as_deref(),
                expected,
                "{document}"
            );
        }
    }
}
