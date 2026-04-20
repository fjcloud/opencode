# OpenCode on OpenShift Dev Spaces

You are running inside an OpenShift DevWorkspace. The `oc` CLI is available and authenticated.

## Project layout

When creating a new application, scaffold:

- `src/` — application source code and Dockerfile
- `deploy/` — Kustomize manifests (base + overlays per environment)

Do not modify workspace config files (`opencode.json`, `devfile.yaml`, `AGENTS.md`).

## Bootstrap

Before writing code, create namespaces, grant image-pull permissions, and create the build pipeline:

```bash
APP=<app>
oc new-project ${APP}-build
oc new-project ${APP}-dev
oc new-project ${APP}-stage
oc new-project ${APP}-prod

# REQUIRED: allow dev/stage/prod to pull images from the build namespace
for ns in ${APP}-dev ${APP}-stage ${APP}-prod; do
  oc policy add-role-to-user system:image-puller system:serviceaccount:${ns}:default -n ${APP}-build
done

oc new-build --name=${APP} --binary --strategy=docker -n ${APP}-build
```

**Without the `system:image-puller` grants above, deployments WILL fail with `ImagePullBackOff`.**

Then scaffold `deploy/` with this Kustomize structure:

```
deploy/
  base/
    kustomization.yaml
    deployment.yaml
    service.yaml
    route.yaml
  overlays/
    dev/kustomization.yaml
    stage/kustomization.yaml
    prod/kustomization.yaml
```

Every Deployment MUST reference the internal registry image using the full `image-registry.openshift-image-registry.svc:5000/<namespace>/<imagestream>:<tag>` format and use the `image.openshift.io/triggers` annotation:

```yaml
spec:
  containers:
    - name: <app>
      image: image-registry.openshift-image-registry.svc:5000/<app>-build/<app>:latest
metadata:
  annotations:
    image.openshift.io/triggers: >-
      [{"from":{"kind":"ImageStreamTag","name":"<app>:latest","namespace":"<app>-build"},
        "fieldPath":"spec.template.spec.containers[?(@.name==\"<app>\")].image"}]
```

## Workflow

1. Write code in `src/`
2. Test locally: `podman build -t ${APP}:test src/` then `podman run --rm -p 8080:8080 ${APP}:test`
3. Build on-cluster: `oc start-build ${APP} --from-dir=src/ -n ${APP}-build --follow`
4. Deploy: `oc apply -k deploy/overlays/dev -n ${APP}-dev`
5. Verify: `oc rollout status`, `oc logs`, `oc get routes`
6. Promote (never rebuild):
   ```bash
   oc tag ${APP}-build/${APP}:latest ${APP}-build/${APP}:stage
   oc apply -k deploy/overlays/stage -n ${APP}-stage
   ```

Local `podman build` is for testing only. Deployable images MUST be built via `oc start-build`.

## Dockerfile rules

- Base on UBI images (`registry.access.redhat.com/ubi9/ubi-minimal` or language-specific UBI)
- Always multi-stage: build stage + minimal runtime stage
- Always `USER 1001`, never root
- Always create edge TLS routes: `oc create route edge`

### Multi-stage pattern (MANDATORY)

OpenShift builds run as a random UID — you CANNOT write to root-level paths (`/app`, `/output`) in the builder stage. Build into the base image's workdir and copy from there.

```dockerfile
# ---- build ----
FROM registry.access.redhat.com/ubi9/go-toolset:latest AS builder
WORKDIR /opt/app-root/src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -o ./app .

# ---- runtime ----
FROM registry.access.redhat.com/ubi9/ubi-minimal:latest
WORKDIR /app
COPY --from=builder /opt/app-root/src/app .
COPY --from=builder /opt/app-root/src/templates/ ./templates/
COPY --from=builder /opt/app-root/src/static/ ./static/
RUN chown -R 1001:0 /app && chmod -R g=u /app
EXPOSE 8080
USER 1001
CMD ["./app"]
```

Rules:
- **Builder**: use the base image's `WORKDIR` (e.g. `/opt/app-root/src`), build output into `./` — never `-o /some-root-path`
- **Runtime**: `COPY --from=builder` with full path, then `chown 1001:0` + `chmod g=u` on all writable dirs
- **Static assets**: COPY all `templates/` and `static/` dirs into runtime — they are NOT embedded in the binary
- OpenShift assigns random UID but always GID 0 — dirs must be group-writable

## Networking

Service `targetPort` MUST match the container's `EXPOSE` port (8080), not default 80:

```yaml
spec:
  ports:
    - port: 8080
      targetPort: 8080
```

## Code rules

- HTML/templates MUST be in separate `.html` files under `templates/` or `static/` — NEVER inline HTML strings in Go, Python, or any application code. Use `template.ParseFiles()`, `template.ParseGlob()`, or equivalent.
- CSS/JS MUST be in separate files under `static/`, never inline in templates beyond minimal bootstrap.
