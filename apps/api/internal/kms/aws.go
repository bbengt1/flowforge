package kms

import (
	"context"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/kms"
	smithylog "github.com/aws/smithy-go/logging"
)

const (
	envAWSRegion   = "KMS_AWS_REGION"
	envAWSKeyID    = "KMS_AWS_KEY_ID"
	envAWSAccess   = "KMS_AWS_ACCESS_KEY_ID"
	envAWSSecret   = "KMS_AWS_SECRET_ACCESS_KEY"
	envAWSToken    = "KMS_AWS_SESSION_TOKEN"
	envAWSEndpoint = "KMS_AWS_ENDPOINT"
)

type awsProvider struct {
	keyID  string
	client *kms.Client
}

func (p *awsProvider) Name() string  { return "aws" }
func (p *awsProvider) KeyID() string { return p.keyID }

func (p *awsProvider) Wrap(ctx context.Context, kek []byte) ([]byte, error) {
	if len(kek) != 32 || p == nil || p.client == nil {
		return nil, ErrUnavailable
	}
	out, err := p.client.Encrypt(ctx, &kms.EncryptInput{
		KeyId:             aws.String(p.keyID),
		Plaintext:         kek,
		EncryptionContext: encryptionContext(),
	})
	if err != nil || out == nil || len(out.CiphertextBlob) == 0 {
		return nil, ErrUnavailable
	}
	return append([]byte(nil), out.CiphertextBlob...), nil
}

func (p *awsProvider) Unwrap(ctx context.Context, keyID string, wrapped []byte) ([]byte, error) {
	if p == nil || p.client == nil || len(wrapped) == 0 {
		return nil, ErrUnavailable
	}
	if keyID == "" {
		keyID = p.keyID
	}
	if !validKeyID(keyID) {
		return nil, ErrUnavailable
	}
	out, err := p.client.Decrypt(ctx, &kms.DecryptInput{
		KeyId:             aws.String(keyID),
		CiphertextBlob:    wrapped,
		EncryptionContext: encryptionContext(),
	})
	if err != nil || out == nil {
		return nil, ErrUnavailable
	}
	kek := append([]byte(nil), out.Plaintext...)
	Wipe(out.Plaintext)
	return kek, nil
}

func encryptionContext() map[string]string {
	return map[string]string{"purpose": Purpose}
}

func openAWS(productionLocked bool) (*awsProvider, error) {
	region := firstEnv(envAWSRegion, "AWS_REGION")
	if region == "" || !awsRegion.MatchString(region) {
		return nil, errStringf("%s must be set", envAWSRegion)
	}
	keyID := firstEnv(envAWSKeyID, EnvKeyID)
	if !validKeyID(keyID) {
		return nil, errStringf("%s or %s is required", envAWSKeyID, EnvKeyID)
	}
	access := firstEnv(envAWSAccess, "AWS_ACCESS_KEY_ID")
	secret := firstEnv(envAWSSecret, "AWS_SECRET_ACCESS_KEY")
	token := firstEnv(envAWSToken, "AWS_SESSION_TOKEN")
	if access == "" || secret == "" {
		return nil, errStringf("%s and %s are required", envAWSAccess, envAWSSecret)
	}
	if err := singleLine(access, envAWSAccess); err != nil {
		return nil, err
	}
	if err := singleLine(secret, envAWSSecret); err != nil {
		return nil, err
	}
	if token != "" {
		if err := singleLine(token, envAWSToken); err != nil {
			return nil, err
		}
	}
	endpoint, err := parseOrigin(getenv(envAWSEndpoint), envAWSEndpoint, productionLocked)
	if err != nil {
		return nil, err
	}
	cfg := aws.Config{
		Region:      region,
		Credentials: credentials.NewStaticCredentialsProvider(access, secret, token),
		HTTPClient:  newHTTPClient(),
		Logger:      smithylog.Nop{},
	}
	client := kms.NewFromConfig(cfg, func(o *kms.Options) {
		if endpoint != "" {
			o.BaseEndpoint = aws.String(endpoint)
		}
	})
	return &awsProvider{keyID: keyID, client: client}, nil
}

func singleLine(val, envName string) error {
	if strings.ContainsAny(val, "\r\n") || len(val) > 4096 {
		return errStringf("%s is invalid", envName)
	}
	return nil
}
