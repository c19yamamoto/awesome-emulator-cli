using Amazon.SecurityToken;

using var sts = new AmazonSecurityTokenServiceClient();
var identity = await sts.GetCallerIdentityAsync();
if (identity.Account != "000000000000")
{
    throw new InvalidOperationException($"Expected the emulator account, got {identity.Account}");
}
Console.WriteLine(identity.Account);
