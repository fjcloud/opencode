# OpenCode on OpenShift Dev Spaces

You are running inside an OpenShift DevWorkspace container (Universal Developer Image).
The cluster is OpenShift 4.x on AWS, accessed via `oc` CLI (already authenticated).

You are powered by a **local LLM** (Qwen3.5-35B-A3B-AWQ) served via vLLM on a GPU node in this cluster.
The inference endpoint is `http://qwen35-predictor.llm-inference.svc.cluster.local:8080/v1` — OpenAI-compatible, no external API calls.
This means low latency, no data leaves the cluster, and no API key management.

## Project layout

- `src/` — all application source code lives here
- `deploy/` — Kubernetes/OpenShift manifests (Kustomize-ready, GitOps-compatible)
- `opencode.json` — OpenCode config (model, provider)
- `devfile.yaml` — DevWorkspace definition
- `AGENTS.md` — this file

Always create new code under `src/` and deployment manifests under `deploy/`. Keep the repo root clean.

## Bootstrap — first thing to do for a new app

Before writing any code, create the four namespaces and wire up image pull permissions:

```bash
APP=<app>
oc new-project ${APP}-build
oc new-project ${APP}-dev
oc new-project ${APP}-stage
oc new-project ${APP}-prod

for ns in ${APP}-dev ${APP}-stage ${APP}-prod; do
  oc policy add-role-to-user system:image-puller system:serviceaccount:${ns}:default -n ${APP}-build
done
```

Then scaffold the full Kustomize structure under `deploy/` (base + dev/stage/prod overlays) and create the BuildConfig in the build namespace:

```bash
oc new-build --name=${APP} --binary --strategy=docker -n ${APP}-build
```

This ensures all three environments and the build pipeline exist from day one — not as an afterthought.

## Development workflow

1. Write code in `src/`
2. Validate locally first with `podman build -t ${APP}:test src/` then `podman run --rm -p 8080:8080 ${APP}:test` — fast feedback loop, catches Dockerfile errors before wasting cluster build time
3. Once local build passes, build on-cluster: `oc start-build ${APP} --from-dir=src/ -n ${APP}-build --follow`
4. Deploy to dev: `oc apply -k deploy/overlays/dev -n ${APP}-dev`
5. Verify: `oc rollout status`, `oc logs`, `oc get routes`
6. When dev is validated, promote to stage then prod by tagging (never rebuild):
   ```bash
   oc tag ${APP}-build/${APP}:latest ${APP}-build/${APP}:stage
   oc tag ${APP}-build/${APP}:stage  ${APP}-build/${APP}:prod
   ```
7. Deploy stage/prod: `oc apply -k deploy/overlays/stage -n ${APP}-stage` / `oc apply -k deploy/overlays/prod -n ${APP}-prod`

**Important**: The local `podman build` is for quick iteration only. All deployable images MUST be built in `${APP}-build` via `oc start-build`. Never push or deploy a locally-built image.

## Namespace strategy

Four namespaces per application (created during bootstrap):

| Namespace | Purpose |
|-----------|---------|
| `<app>-build` | BuildConfig + ImageStream. Images are built and pushed here. |
| `<app>-dev` | Development environment. Pulls images from `<app>-build`. |
| `<app>-stage` | Staging / QA. Pulls images from `<app>-build`. |
| `<app>-prod` | Production. Pulls images from `<app>-build`. |

Every Deployment MUST use the `image.openshift.io/triggers` annotation to auto-deploy when an ImageStream tag is updated:

```yaml
metadata:
  annotations:
    image.openshift.io/triggers: >-
      [{"from":{"kind":"ImageStreamTag","name":"<image>:<tag>","namespace":"<app>-build"},
        "fieldPath":"spec.template.spec.containers[?(@.name==\"<container>\")].image"}]
```

This way the image field is automatically resolved and updated by OpenShift — no hardcoded registry URLs. When a tag is updated, the trigger annotation rolls out the new image automatically.

## OpenShift conventions

- Use `oc` (not `kubectl`) — it has OpenShift-specific commands (routes, builds, etc.)
- Always create edge-terminated TLS Routes: `oc create route edge <name> --service=<svc>` (never plain HTTP)
- Check cluster state before deploying: `oc project`, `oc status`
- Always build images on-cluster in `<app>-build` using `oc new-build --name=<app> --binary -n <app>-build` then `oc start-build <app> --from-dir=src/ -n <app>-build --follow`
- Local `podman build` is for testing only — never use it to produce deployable images

## Containerization

- Every app must have a `Dockerfile` in `src/`
- Use multi-stage builds: separate build image from runtime image to reduce attack surface
- Base on `registry.access.redhat.com/ubi9/ubi-minimal` or appropriate UBI images — trusted, tested, supported
- Always use the latest UBI tag to include all security fixes
- Never run as root — use `USER 1001` and support arbitrary user IDs (OpenShift restricted SCC)
- Expose only necessary ports
- One process per container — no supervisor hacks

### Multi-stage Dockerfile pattern (MANDATORY)

OpenShift build containers run as a random UID. You CANNOT write to arbitrary paths like `/app`, `/go-webserver`, or `/output` in the builder stage — they will fail with "permission denied". Always build into a **writable path** (`/tmp` or the current workdir) and copy from there.

Correct pattern (Go example):

```dockerfile
# ---- build stage ----
FROM registry.access.redhat.com/ubi9/go-toolset:1.21 AS builder
WORKDIR /opt/app-root/src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o ./app .

# ---- runtime stage ----
FROM registry.access.redhat.com/ubi9/ubi-minimal:latest
WORKDIR /app
COPY --from=builder /opt/app-root/src/app .
RUN chown -R 1001:0 /app && chmod -R g=u /app
EXPOSE 8080
USER 1001
CMD ["./app"]
```

Key rules:
- **Builder stage**: use the `WORKDIR` provided by the base image (e.g. `/opt/app-root/src` for UBI go-toolset). Build the binary into the current directory (`./app`), NOT into a root-level path like `/app` or `/binary`
- **Runtime stage**: `COPY --from=builder` using the full path from the builder's workdir
- **Never** `RUN ... -o /some-root-path` in a builder stage — the random UID cannot write there
- Apply `chown 1001:0` and `chmod g=u` on all runtime directories before switching to `USER 1001`

### OpenShift UID and file permissions

OpenShift runs containers with a **random UID** (restricted SCC). Most permission errors come from files/directories in the image that only root can write to. Every Dockerfile MUST handle this:

- Set `USER 1001` — never run as root
- Any directory the app writes to at runtime must be writable by the root **group** (GID 0), because OpenShift assigns a random UID but always GID 0:
  ```dockerfile
  RUN chown -R 1001:0 /app && chmod -R g=u /app
  ```
- For temp/cache/log directories, same pattern:
  ```dockerfile
  RUN mkdir -p /app/tmp /app/logs && \
      chown -R 1001:0 /app/tmp /app/logs && \
      chmod -R g=u /app/tmp /app/logs
  ```
- Never write to `/etc/passwd` or `/etc/group` at runtime — if the app needs the UID to resolve, use an `nss_wrapper` or add an `entrypoint.sh` that creates the user entry dynamically
- If the base image (e.g. nginx, redis) expects to run as root or a specific UID, check Red Hat's version (`registry.access.redhat.com/ubi9/...`) which is already adapted for arbitrary UIDs
- Test locally with a random UID to catch permission issues early:
  ```bash
  podman run --rm --user 1000620000:0 ${APP}:test
  ```

## Kubernetes manifests

Place all manifests in `deploy/`. Structure for Kustomize:

```
deploy/
  base/
    kustomization.yaml
    deployment.yaml
    service.yaml
    route.yaml
  overlays/
    dev/
      kustomization.yaml
    stage/
      kustomization.yaml
    prod/
      kustomization.yaml
```

Deploy per environment (see workflow for the full sequence):

```bash
oc apply -k deploy/overlays/dev   -n <app>-dev
oc apply -k deploy/overlays/stage -n <app>-stage
oc apply -k deploy/overlays/prod  -n <app>-prod
```

## Manifest requirements

Every Deployment MUST include:

- **Resource requests and limits** for CPU and memory on every container
- **Liveness probe** — restarts the pod if the app is stuck
- **Readiness probe** — stops routing traffic until the app is ready
- **Graceful shutdown** — handle SIGTERM, drain in-flight requests, set `terminationGracePeriodSeconds`
- **PodDisruptionBudget** — protect availability during node maintenance and cluster scaling

Configuration MUST be external to the image:

- Use `ConfigMap` for non-sensitive config
- Use `Secret` for credentials (never hardcode)
- The same image is promoted from dev to prod — only config changes per environment

## Observability

- Write logs to stdout/stderr — OpenShift collects them automatically
- Expose a `/metrics` endpoint (Prometheus format) for monitoring
- Expose a `/health` and `/ready` endpoint for probes
- Set up alerts on error rates, latency, and resource usage

## Testing and validation

- Run unit tests locally before deploying: use the language's test runner
- After `oc apply`, verify: `oc rollout status deployment/<name>`
- Check pod logs: `oc logs -f deployment/<name>`
- Test the route: `curl -s https://<route-hostname>/health`
- Clean up failed resources: `oc delete` what you created

## Code style

- Prefer simplicity and readability over cleverness
- One responsibility per file
- Meaningful names, no abbreviations
- Handle errors explicitly — don't silently ignore them
- Comment only what the code cannot express on its own
