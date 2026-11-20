package example;

import software.amazon.awssdk.services.sts.StsClient;

public final class Smoke {
    public static void main(String[] args) {
        try (StsClient sts = StsClient.create()) {
            String account = sts.getCallerIdentity().account();
            if (!"000000000000".equals(account)) {
                throw new IllegalStateException("Expected the emulator account, got " + account);
            }
            System.out.println(account);
        }
    }
}
