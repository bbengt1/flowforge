package artifact

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

const (
	testAccessKey = "AKIADO-NOT-LEAK"
	testSecret    = "s3-secret-do-not-leak"
	testKMSKey    = "arn:aws:kms:us-east-1:123:key/do-not-leak"
	testFailRef   = "99999999-9999-4999-8999-999999999999"
)

func TestParseS3EmptyIsDisabled(t *testing.T) {
	clearS3Env(t)
	cfg, err := ParseS3FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Enabled {
		t.Fatal("empty env should disable S3")
	}
}

func TestParseS3PartialFailsWithoutValues(t *testing.T) {
	clearS3Env(t)
	t.Setenv(EnvS3Bucket, "flowforge-artifacts")
	t.Setenv(EnvS3SecretAccessKey, testSecret)
	_, err := ParseS3FromEnv()
	if err == nil {
		t.Fatal("expected partial config to fail")
	}
	if strings.Contains(err.Error(), testSecret) || strings.Contains(err.Error(), "flowforge-artifacts") {
		t.Fatalf("error leaked config values: %v", err)
	}
}

func TestParseS3RejectsUserinfo(t *testing.T) {
	clearS3Env(t)
	t.Setenv(EnvS3Endpoint, "http://"+testAccessKey+":"+testSecret+"@minio:9000")
	t.Setenv(EnvS3Bucket, "flowforge-artifacts")
	t.Setenv(EnvS3AccessKeyID, testAccessKey)
	t.Setenv(EnvS3SecretAccessKey, testSecret)
	_, err := ParseS3FromEnv()
	if err == nil {
		t.Fatal("expected userinfo to fail")
	}
	if strings.Contains(err.Error(), testSecret) || strings.Contains(err.Error(), testAccessKey) {
		t.Fatalf("error leaked credentials: %v", err)
	}
}

func TestParseS3KMSRequiresKeyID(t *testing.T) {
	clearS3Env(t)
	setCompleteS3Env(t, "")
	t.Setenv(EnvS3SSE, sseKMS)
	if _, err := ParseS3FromEnv(); err == nil {
		t.Fatal("expected missing KMS key id to fail")
	}
	t.Setenv(EnvS3SSEKMSKeyID, testKMSKey)
	cfg, err := ParseS3FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SSE != sseKMS || cfg.SSEKMSKeyID != testKMSKey {
		t.Fatal("kms config not stored")
	}
}

func TestParseS3PrefixRejected(t *testing.T) {
	clearS3Env(t)
	setCompleteS3Env(t, "")
	secretPrefix := testSecret + "/artifacts"
	t.Setenv(EnvS3Prefix, secretPrefix)
	_, err := ParseS3FromEnv()
	if err == nil {
		t.Fatal("expected a caller prefix to be rejected")
	}
	if strings.Contains(err.Error(), testSecret) || strings.Contains(err.Error(), secretPrefix) {
		t.Fatalf("error leaked prefix: %v", err)
	}
	if !strings.Contains(err.Error(), EnvS3Prefix) {
		t.Fatalf("error = %v", err)
	}
}

func TestOpenProductionRequiresS3(t *testing.T) {
	ctx := context.Background()
	_, _, err := LoadStore(ctx, StoreConfig{Dir: t.TempDir(), ProductionLocked: true})
	if err == nil {
		t.Fatal("filesystem store must fail closed in production")
	}
	_, _, err = LoadStore(ctx, StoreConfig{ProductionLocked: true})
	if err == nil {
		t.Fatal("memory store must fail closed in production")
	}
	_, _, err = LoadStore(ctx, StoreConfig{
		ProductionLocked: true,
		S3: S3Config{
			Enabled:         true,
			Endpoint:        "http://127.0.0.1:9",
			Bucket:          "flowforge-artifacts",
			Region:          "us-east-1",
			AccessKeyID:     testAccessKey,
			SecretAccessKey: testSecret,
			CreateBucket:    true,
			UsePathStyle:    true,
		},
	})
	if err == nil || !strings.Contains(err.Error(), EnvS3CreateBucket) {
		t.Fatalf("create-bucket in production: %v", err)
	}
	if strings.Contains(err.Error(), testSecret) {
		t.Fatalf("error leaked secret: %v", err)
	}
}

func TestOpenFilesystemAndMemory(t *testing.T) {
	ctx := context.Background()
	fs, kind, err := LoadStore(ctx, StoreConfig{Dir: t.TempDir()})
	if err != nil || kind != "filesystem" {
		t.Fatalf("filesystem kind=%s err=%v", kind, err)
	}
	if _, ok := fs.(*FilesystemObjects); !ok {
		t.Fatalf("store = %T", fs)
	}
	mem, kind, err := LoadStore(ctx, StoreConfig{})
	if err != nil || kind != "memory" {
		t.Fatalf("memory kind=%s err=%v", kind, err)
	}
	if _, ok := mem.(*MemoryObjects); !ok {
		t.Fatalf("store = %T", mem)
	}
}

func TestS3PutGetSurvivesNewClient(t *testing.T) {
	fake := newFakeS3()
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)

	cfg := testS3Config(srv.URL)
	cfg.SSE = sseAES256
	first, kind, err := LoadStore(context.Background(), StoreConfig{S3: cfg})
	if err != nil || kind != "s3" {
		t.Fatalf("open kind=%s err=%v", kind, err)
	}
	tenant := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	ws := "11111111-1111-1111-1111-111111111111"
	ref := "22222222-2222-2222-2222-222222222222"
	payload := []byte("ciphertext-survives-restart")
	if err := first.Put(tenant, ws, ref, payload); err != nil {
		t.Fatal(err)
	}
	if err := first.Put(tenant, ws, "../escape", payload); err == nil {
		t.Fatal("expected locator escape to fail")
	}
	if fake.requestsAfterEscape() {
		t.Fatal("invalid locator must not reach the object store")
	}
	if got := fake.sse(); got != sseAES256 {
		t.Fatalf("sse header = %q", got)
	}
	if fake.userMetadata() {
		t.Fatal("object metadata, tagging, or content-disposition was set")
	}
	key := tenant + "/" + ws + "/" + ref
	if !fake.hasKey("flowforge-artifacts", key) {
		t.Fatal("object key missing after put")
	}

	// A second client is a restarted process: no in-memory payload cache.
	second, _, err := LoadStore(context.Background(), StoreConfig{S3: cfg})
	if err != nil {
		t.Fatal(err)
	}
	got, err := second.Get(tenant, ws, ref)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != string(payload) {
		t.Fatalf("got %q", got)
	}
	if err := second.Delete(tenant, ws, ref); err != nil {
		t.Fatal(err)
	}
	if _, err := first.Get(tenant, ws, ref); err != ErrNotFound {
		t.Fatalf("get after delete = %v", err)
	}
}

func TestS3ErrorDoesNotLeakSecrets(t *testing.T) {
	fake := newFakeS3()
	fake.leak = testSecret + " " + testAccessKey + " " + testKMSKey
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)

	cfg := testS3Config(srv.URL)
	cfg.SSE = sseKMS
	cfg.SSEKMSKeyID = testKMSKey
	store, _, err := LoadStore(context.Background(), StoreConfig{S3: cfg})
	if err != nil {
		t.Fatal(err)
	}
	err = store.Put("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "11111111-1111-1111-1111-111111111111", testFailRef, []byte("x"))
	if err == nil {
		t.Fatal("expected put to fail")
	}
	if strings.Contains(err.Error(), testSecret) || strings.Contains(err.Error(), testAccessKey) || strings.Contains(err.Error(), testKMSKey) {
		t.Fatalf("error leaked secrets: %v", err)
	}
	if !strings.Contains(err.Error(), errObjectStore.Error()) {
		t.Fatalf("error = %v", err)
	}
}

func TestS3MissingBucketFailsClosed(t *testing.T) {
	fake := newFakeS3()
	fake.refuseCreate = true
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	cfg := testS3Config(srv.URL)
	cfg.CreateBucket = false
	_, _, err := LoadStore(context.Background(), StoreConfig{S3: cfg})
	if err == nil || !strings.Contains(err.Error(), errBucketUnavailable.Error()) {
		t.Fatalf("missing bucket: %v", err)
	}
	if strings.Contains(err.Error(), testSecret) || strings.Contains(err.Error(), cfg.Bucket) {
		t.Fatalf("error leaked store details: %v", err)
	}
}

func testS3Config(endpoint string) S3Config {
	return S3Config{
		Enabled:         true,
		Endpoint:        endpoint,
		Bucket:          "flowforge-artifacts",
		Region:          "us-east-1",
		AccessKeyID:     testAccessKey,
		SecretAccessKey: testSecret,
		UsePathStyle:    true,
		CreateBucket:    true,
	}
}

func clearS3Env(t *testing.T) {
	t.Helper()
	for _, name := range []string{
		EnvS3Endpoint, EnvS3Bucket, EnvS3Region, EnvS3AccessKeyID, EnvS3SecretAccessKey,
		EnvS3SessionToken, EnvS3UsePathStyle, EnvS3SSE, EnvS3SSEKMSKeyID, EnvS3Prefix, EnvS3CreateBucket,
	} {
		t.Setenv(name, "")
	}
}

func setCompleteS3Env(t *testing.T, endpoint string) {
	t.Helper()
	t.Setenv(EnvS3Endpoint, endpoint)
	t.Setenv(EnvS3Bucket, "flowforge-artifacts")
	t.Setenv(EnvS3Region, "us-east-1")
	t.Setenv(EnvS3AccessKeyID, testAccessKey)
	t.Setenv(EnvS3SecretAccessKey, testSecret)
	t.Setenv(EnvS3UsePathStyle, "true")
}

type fakeS3 struct {
	mu           sync.Mutex
	buckets      map[string]bool
	objects      map[string][]byte
	sseHeader    string
	putHeader    http.Header
	leak         string
	refuseCreate bool
	puts         int
}

func newFakeS3() *fakeS3 {
	return &fakeS3{buckets: map[string]bool{}, objects: map[string][]byte{}}
}

func (f *fakeS3) sse() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sseHeader
}

func (f *fakeS3) hasKey(bucket, key string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.objects[bucket+"\n"+key]
	return ok
}

func (f *fakeS3) userMetadata() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.putHeader == nil {
		return false
	}
	for name := range f.putHeader {
		lower := strings.ToLower(name)
		if strings.HasPrefix(lower, "x-amz-meta-") || lower == "content-disposition" || lower == "x-amz-tagging" {
			return true
		}
	}
	return false
}

func (f *fakeS3) requestsAfterEscape() bool {
	// Put of an invalid locator must not increment the successful/attempted object put count
	// beyond the one valid put. Head/Create happen first.
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.puts != 1
}

func (f *fakeS3) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	bucket, key, _ := strings.Cut(path, "/")
	key = strings.TrimPrefix(key, "/")
	switch r.Method {
	case http.MethodHead:
		f.mu.Lock()
		ok := f.buckets[bucket]
		f.mu.Unlock()
		if !ok {
			writeS3Error(w, http.StatusNotFound, "NotFound", "missing")
			return
		}
		w.WriteHeader(http.StatusOK)
	case http.MethodPut:
		if key == "" {
			if f.refuseCreate {
				writeS3Error(w, http.StatusForbidden, "AccessDenied", f.leak)
				return
			}
			f.mu.Lock()
			f.buckets[bucket] = true
			f.mu.Unlock()
			w.WriteHeader(http.StatusOK)
			return
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeS3Error(w, http.StatusBadRequest, "InvalidRequest", "body")
			return
		}
		f.mu.Lock()
		f.puts++
		f.sseHeader = r.Header.Get("X-Amz-Server-Side-Encryption")
		f.putHeader = r.Header.Clone()
		fail := key == testFailRef || strings.HasSuffix(key, "/"+testFailRef)
		if !fail {
			f.buckets[bucket] = true
			f.objects[bucket+"\n"+key] = append([]byte(nil), body...)
		}
		leak := f.leak
		f.mu.Unlock()
		if fail {
			writeS3Error(w, http.StatusInternalServerError, "InternalError", leak)
			return
		}
		w.WriteHeader(http.StatusOK)
	case http.MethodGet:
		f.mu.Lock()
		raw, ok := f.objects[bucket+"\n"+key]
		f.mu.Unlock()
		if !ok {
			writeS3Error(w, http.StatusNotFound, "NoSuchKey", "missing")
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(raw)
	case http.MethodDelete:
		f.mu.Lock()
		delete(f.objects, bucket+"\n"+key)
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	default:
		writeS3Error(w, http.StatusMethodNotAllowed, "MethodNotAllowed", r.Method)
	}
}

func writeS3Error(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>%s</Code><Message>%s</Message></Error>`, code, msg)
}
