use aws_config::BehaviorVersion;

#[tokio::main]
async fn main() {
    let config = aws_config::defaults(BehaviorVersion::latest()).load().await;
    let identity = aws_sdk_sts::Client::new(&config)
        .get_caller_identity()
        .send()
        .await
        .expect("call AWS STS through the emulator");
    let account = identity.account().unwrap_or_default();
    assert_eq!(account, "000000000000", "expected the emulator account");
    println!("{account}");
}
