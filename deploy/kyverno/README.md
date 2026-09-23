# Image admission

Kyverno is not installed by `kubectl apply -k deploy/k8s`. Install Kyverno 1.11 or newer, then:

```bash
kubectl apply -k deploy/kyverno
```

`flowforge-verify-images.yaml` is `Enforce` / `failurePolicy: Fail`. It denies a FlowForge pod unless the image is digest-pinned, signed by the `main` supply-chain workflow (keyless), and carries a SLSA provenance v1 attestation from that same workflow. `mutateDigest` is false: a tag is not rewritten into a digest.

`flowforge-verify-images-key.example.yaml` is not applied. It is the air-gapped public-key shape. Do not commit a key.

Digest pins on the reference stack also use `deploy/admission` (Kubernetes 1.30+). That policy does not verify signatures. Apply it before this directory. Verification commands and the unset digest: [policy.md](../supply-chain/policy.md).
