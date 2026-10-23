/// Saved connection settings take precedence over these first-run defaults.
pub const SERVER_URL: &str = if cfg!(debug_assertions) {
    "http://127.0.0.1:8003"
} else {
    "http://192.168.3.123:8003"
};

/// The public discovery service shared by desktop and network-service first-run defaults.
pub const DISCOVERY_URL: &str = "https://39.106.128.14";

#[cfg(test)]
mod tests {
    #[test]
    fn build_channel_selects_expected_backend() {
        let expected = if cfg!(debug_assertions) {
            "http://127.0.0.1:8003"
        } else {
            "http://192.168.3.123:8003"
        };
        assert_eq!(super::SERVER_URL, expected);
        assert_eq!(super::DISCOVERY_URL, "https://39.106.128.14");
    }
}
