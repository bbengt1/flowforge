// Package kms wraps the vault data-encryption KEK with a cloud KMS.
//
// Providers speak AWS KMS, Cloud KMS, Azure Key Vault, and HashiCorp
// Vault Transit. The process keeps only wrapped KEK bytes at rest.
// Plaintext KEK and DEK material must not be logged, returned, or
// placed in an error string.
package kms
