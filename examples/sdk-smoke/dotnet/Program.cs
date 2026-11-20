using Amazon.SecurityToken;
using Amazon.SecurityToken.Model;
using System.Threading;

using var sts = new AmazonSecurityTokenServiceClient();
var identity = await sts.GetCallerIdentityAsync(new GetCallerIdentityRequest(), CancellationToken.None);
if (identity.Account != "000000000000")
{
    throw new InvalidOperationException($"Expected the emulator account, got {identity.Account}");
}
Console.WriteLine(identity.Account);
