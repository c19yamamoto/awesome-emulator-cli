package main

import (
	"context"
	"fmt"
	"os"

	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/sts"
)

func main() {
	awsConfig, err := config.LoadDefaultConfig(context.Background())
	if err != nil {
		panic(err)
	}
	identity, err := sts.NewFromConfig(awsConfig).GetCallerIdentity(context.Background(), &sts.GetCallerIdentityInput{})
	if err != nil {
		panic(err)
	}
	if identity.Account == nil || *identity.Account != "000000000000" {
		fmt.Fprintf(os.Stderr, "expected the emulator account, got %v\n", identity.Account)
		os.Exit(1)
	}
	fmt.Println(*identity.Account)
}
