# Kubernetes foundation

Apply with:

```bash
kubectl apply -k deploy/k8s
```

Replace before any real environment:

- `ghcr.io/bbengt1/flowforge-api:foundation` with a **digest-pinned** image
- `api.example.com` and the `flowforge-tls` secret (or enable cert-manager)
- `deploy/k8s/api-secret.example.yaml` with a real `DATABASE_URL` (external secrets / sealed secrets)
- Database egress if PostgreSQL is not a pod labeled `app.kubernetes.io/component=postgres` in this namespace

The API process also applies forward-only migrations on connect. Production TLS is terminated at Ingress; the API ConfigMap sets `REQUIRE_TLS=true` and `TRUSTED_PROXY_CIDRS` for the cluster ranges. HTTP liveness/readiness probes to `/api/v1/health` and `/api/v1/readiness` are exempt from that TLS requirement so kubelet can reach the pod directly.
