import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";

const identity = await new STSClient({}).send(new GetCallerIdentityCommand({}));
if (identity.Account !== "000000000000") {
  throw new Error(`Expected the emulator account, got ${identity.Account}`);
}
console.log(identity.Account);
