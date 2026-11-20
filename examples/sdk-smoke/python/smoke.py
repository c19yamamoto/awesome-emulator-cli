import boto3

identity = boto3.client("sts").get_caller_identity()
if identity["Account"] != "000000000000":
    raise SystemExit(f"Expected the emulator account, got {identity['Account']}")
print(identity["Account"])
