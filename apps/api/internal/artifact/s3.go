package artifact

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	smithy "github.com/aws/smithy-go"
	smithylog "github.com/aws/smithy-go/logging"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

// S3 environment. Any of these (except region alone) selects the S3
// backend. Values are never written to logs.
const (
	EnvS3Endpoint        = "ARTIFACT_S3_ENDPOINT"
	EnvS3Bucket          = "ARTIFACT_S3_BUCKET"
	EnvS3Region          = "ARTIFACT_S3_REGION"
	EnvS3AccessKeyID     = "ARTIFACT_S3_ACCESS_KEY_ID"
	EnvS3SecretAccessKey = "ARTIFACT_S3_SECRET_ACCESS_KEY"
	EnvS3SessionToken    = "ARTIFACT_S3_SESSION_TOKEN"
	EnvS3UsePathStyle    = "ARTIFACT_S3_USE_PATH_STYLE"
	EnvS3SSE             = "ARTIFACT_S3_SSE"
	EnvS3SSEKMSKeyID     = "ARTIFACT_S3_SSE_KMS_KEY_ID"
	EnvS3Prefix          = "ARTIFACT_S3_PREFIX"
	EnvS3CreateBucket    = "ARTIFACT_S3_CREATE_BUCKET"
)

const (
	sseAES256 = "AES256"
	sseKMS    = "aws:kms"

	defaultS3Region = "us-east-1"
	s3OpTimeout     = 10 * time.Second
	s3HTTPTimeout   = 30 * time.Second
)

// errObjectStore is the only error returned for a failed S3 call.
// SDK messages can echo signed headers, bucket names, and request bodies.
var errObjectStore = errors.New("artifact object store request failed")

// errBucketUnavailable is returned when the configured bucket is missing
// and this process is not allowed to create it.
var errBucketUnavailable = errors.New("artifact bucket is not available")

// S3Config is an S3-compatible object store. Secret fields must not be logged.
type S3Config struct {
	Endpoint        string
	Bucket          string
	Region          string
	AccessKeyID     string
	SecretAccessKey string
	SessionToken    string
	UsePathStyle    bool
	// SSE is "" (none), AES256, or aws:kms. Payloads are already
	// envelope-encrypted by the caller; SSE is an additional server-side layer.
	SSE          string
	SSEKMSKeyID  string
	CreateBucket bool
	Enabled      bool
}

// StoreConfig selects a backend. ProductionLocked rejects filesystem and
// memory stores and rejects ARTIFACT_S3_CREATE_BUCKET.
type StoreConfig struct {
	Dir              string
	S3               S3Config
	ProductionLocked bool
}

// ParseS3FromEnv reads ARTIFACT_S3_*. An empty set leaves Enabled false.
// A partial set fails closed. The error text names variables, never values.
func ParseS3FromEnv() (S3Config, error) {
	endpoint, err := parseS3Endpoint(os.Getenv(EnvS3Endpoint))
	if err != nil {
		return S3Config{}, err
	}
	bucket := strings.TrimSpace(os.Getenv(EnvS3Bucket))
	region := strings.TrimSpace(os.Getenv(EnvS3Region))
	accessKey := strings.TrimSpace(os.Getenv(EnvS3AccessKeyID))
	secret := strings.TrimSpace(os.Getenv(EnvS3SecretAccessKey))
	token := strings.TrimSpace(os.Getenv(EnvS3SessionToken))
	sse := strings.TrimSpace(os.Getenv(EnvS3SSE))
	kmsKey := strings.TrimSpace(os.Getenv(EnvS3SSEKMSKeyID))
	if strings.TrimSpace(os.Getenv(EnvS3Prefix)) != "" {
		return S3Config{}, fmt.Errorf("%s is not allowed; object keys are tenant/workspace/ref only", EnvS3Prefix)
	}
	createSet, createBucket, err := optionalBool(EnvS3CreateBucket)
	if err != nil {
		return S3Config{}, err
	}
	pathSet, pathStyle, err := optionalBool(EnvS3UsePathStyle)
	if err != nil {
		return S3Config{}, err
	}

	intent := endpoint != "" || bucket != "" || accessKey != "" || secret != "" || token != "" ||
		sse != "" || kmsKey != "" || createSet || pathSet
	if !intent {
		return S3Config{}, nil
	}
	if bucket == "" || accessKey == "" || secret == "" {
		return S3Config{}, fmt.Errorf("%s, %s, and %s are required together", EnvS3Bucket, EnvS3AccessKeyID, EnvS3SecretAccessKey)
	}
	switch sse {
	case "", sseAES256:
		if kmsKey != "" {
			return S3Config{}, fmt.Errorf("%s is only valid when %s=%s", EnvS3SSEKMSKeyID, EnvS3SSE, sseKMS)
		}
	case sseKMS:
		if kmsKey == "" {
			return S3Config{}, fmt.Errorf("%s is required when %s=%s", EnvS3SSEKMSKeyID, EnvS3SSE, sseKMS)
		}
	default:
		return S3Config{}, fmt.Errorf("%s must be %s or %s", EnvS3SSE, sseAES256, sseKMS)
	}
	if region == "" {
		region = defaultS3Region
	}
	if !pathSet {
		pathStyle = endpoint != ""
	}
	return S3Config{
		Endpoint:        endpoint,
		Bucket:          bucket,
		Region:          region,
		AccessKeyID:     accessKey,
		SecretAccessKey: secret,
		SessionToken:    token,
		UsePathStyle:    pathStyle,
		SSE:             sse,
		SSEKMSKeyID:     kmsKey,
		CreateBucket:    createBucket,
		Enabled:         true,
	}, nil
}

func parseS3Endpoint(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return "", fmt.Errorf("%s must be an http or https URL", EnvS3Endpoint)
	}
	if u.User != nil {
		return "", fmt.Errorf("%s must not include userinfo", EnvS3Endpoint)
	}
	if u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return "", fmt.Errorf("%s must be an origin without a path, query, or fragment", EnvS3Endpoint)
	}
	return u.Scheme + "://" + u.Host, nil
}

func optionalBool(name string) (set, val bool, err error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return false, false, nil
	}
	switch strings.ToLower(raw) {
	case "1", "true", "yes", "on":
		return true, true, nil
	case "0", "false", "no", "off":
		return true, false, nil
	default:
		return true, false, fmt.Errorf("%s is invalid", name)
	}
}

// LoadStore returns the object store for cfg. The kind string is s3,
// filesystem, or memory — never a bucket, endpoint, path, or credential.
func LoadStore(ctx context.Context, cfg StoreConfig) (Objects, string, error) {
	if cfg.S3.Enabled {
		if cfg.ProductionLocked && cfg.S3.CreateBucket {
			return nil, "", fmt.Errorf("%s is not allowed in a production-locked process", EnvS3CreateBucket)
		}
		store, err := newS3Objects(ctx, cfg.S3)
		if err != nil {
			return nil, "", err
		}
		return store, "s3", nil
	}
	if cfg.ProductionLocked {
		// Missing bucket or credentials must not fall through to tmpfs or memory.
		return nil, "", fmt.Errorf("production-locked process requires an S3-compatible artifact store (%s, %s, %s)", EnvS3Bucket, EnvS3AccessKeyID, EnvS3SecretAccessKey)
	}
	if root := strings.TrimSpace(cfg.Dir); root != "" {
		fs, err := NewFilesystemObjects(root)
		if err != nil {
			return nil, "", err
		}
		return fs, "filesystem", nil
	}
	return NewMemoryObjects(), "memory", nil
}

// S3Objects stores ciphertext at {tenantID}/{workspaceID}/{ref}.
// Callers envelope-encrypt before Put. Objects carry no user metadata.
// This type never lists objects and never returns bucket names,
// endpoints, or credentials in errors.
type S3Objects struct {
	client       *s3.Client
	bucket       string
	region       string
	sse          string
	kmsKeyID     string
	createBucket bool
}

func newS3Objects(ctx context.Context, cfg S3Config) (*S3Objects, error) {
	if !cfg.Enabled || cfg.Bucket == "" || cfg.AccessKeyID == "" || cfg.SecretAccessKey == "" {
		return nil, fmt.Errorf("%s, %s, and %s are required together", EnvS3Bucket, EnvS3AccessKeyID, EnvS3SecretAccessKey)
	}
	region := cfg.Region
	if region == "" {
		region = defaultS3Region
	}
	awsCfg := aws.Config{
		Region:      region,
		Credentials: credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, cfg.SessionToken),
		HTTPClient:  &http.Client{Timeout: s3HTTPTimeout},
		Logger:      smithylog.Nop{},
	}
	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.UsePathStyle = cfg.UsePathStyle
		if cfg.Endpoint != "" {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
		}
		o.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
		o.ResponseChecksumValidation = aws.ResponseChecksumValidationWhenRequired
	})
	store := &S3Objects{
		client:       client,
		bucket:       cfg.Bucket,
		region:       region,
		sse:          cfg.SSE,
		kmsKeyID:     cfg.SSEKMSKeyID,
		createBucket: cfg.CreateBucket,
	}
	if err := store.ensureBucket(ctx); err != nil {
		return nil, err
	}
	return store, nil
}

func (s *S3Objects) objectKey(tenantID, workspaceID, ref string) (string, error) {
	return scopedObjectKey(tenantID, workspaceID, ref)
}

func (s *S3Objects) ensureBucket(ctx context.Context) error {
	_, err := s.client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(s.bucket)})
	if err == nil {
		return nil
	}
	if !isNotFound(err) {
		return errObjectStore
	}
	if !s.createBucket {
		return errBucketUnavailable
	}
	in := &s3.CreateBucketInput{Bucket: aws.String(s.bucket)}
	if s.region != "" && s.region != defaultS3Region {
		in.CreateBucketConfiguration = &s3types.CreateBucketConfiguration{
			LocationConstraint: s3types.BucketLocationConstraint(s.region),
		}
	}
	if _, err := s.client.CreateBucket(ctx, in); err != nil && !isAlreadyExists(err) {
		return errObjectStore
	}
	return nil
}

// Put writes ciphertext. Missing locators are rejected before any request.
func (s *S3Objects) Put(tenantID, workspaceID, ref string, ciphertext []byte) error {
	key, err := s.objectKey(tenantID, workspaceID, ref)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), s3OpTimeout)
	defer cancel()
	// No Metadata, Tagging, ContentType, or ContentDisposition.
	// Those fields would put filenames or secrets on the object.
	in := &s3.PutObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
		Body:   bytes.NewReader(ciphertext),
	}
	switch s.sse {
	case sseAES256:
		in.ServerSideEncryption = s3types.ServerSideEncryptionAes256
	case sseKMS:
		in.ServerSideEncryption = s3types.ServerSideEncryptionAwsKms
		in.SSEKMSKeyId = aws.String(s.kmsKeyID)
	}
	if _, err := s.client.PutObject(ctx, in); err != nil {
		return errObjectStore
	}
	return nil
}

// Get reads ciphertext for one workspace-scoped ref.
func (s *S3Objects) Get(tenantID, workspaceID, ref string) ([]byte, error) {
	key, err := s.objectKey(tenantID, workspaceID, ref)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), s3OpTimeout)
	defer cancel()
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	})
	if err != nil {
		if isNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, errObjectStore
	}
	defer out.Body.Close()
	raw, err := io.ReadAll(out.Body)
	if err != nil {
		return nil, errObjectStore
	}
	return raw, nil
}

// Delete removes one object. A missing object is not an error.
func (s *S3Objects) Delete(tenantID, workspaceID, ref string) error {
	key, err := s.objectKey(tenantID, workspaceID, ref)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), s3OpTimeout)
	defer cancel()
	if _, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	}); err != nil {
		if isNotFound(err) {
			return nil
		}
		return errObjectStore
	}
	return nil
}

func isNotFound(err error) bool {
	var api smithy.APIError
	if errors.As(err, &api) {
		switch api.ErrorCode() {
		case "NoSuchKey", "NotFound", "NoSuchBucket", "404":
			return true
		}
	}
	var resp *smithyhttp.ResponseError
	if errors.As(err, &resp) && resp.HTTPStatusCode() == http.StatusNotFound {
		return true
	}
	return false
}

func isAlreadyExists(err error) bool {
	var api smithy.APIError
	if errors.As(err, &api) {
		switch api.ErrorCode() {
		case "BucketAlreadyOwnedByYou", "BucketAlreadyExists":
			return true
		}
	}
	return false
}
