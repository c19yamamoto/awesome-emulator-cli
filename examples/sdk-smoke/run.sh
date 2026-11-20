#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

printf '\n== AWS CLI v2 ==\n'
account="$(aws sts get-caller-identity --query Account --output text)"
test "$account" = "000000000000"
printf '%s\n' "$account"

printf '\n== Boto3 ==\n'
python "$script_dir/python/smoke.py"

printf '\n== AWS SDK for JavaScript v3 ==\n'
node "$script_dir/javascript/smoke.mjs"

printf '\n== AWS SDK for Java 2.x ==\n'
classpath="$(cat "$script_dir/java/target/classpath.txt")"
java -cp "$script_dir/java/target/classes:$classpath" example.Smoke

printf '\n== AWS SDK for Go v2 ==\n'
(cd "$script_dir/go" && go run .)

printf '\n== AWS SDK for Rust ==\n'
cargo run --locked --offline --manifest-path "$script_dir/rust/Cargo.toml"

printf '\n== AWS SDK for .NET ==\n'
dotnet run --no-restore --project "$script_dir/dotnet/Smoke.csproj"
