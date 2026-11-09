# syntax=docker/dockerfile:1
#  =====================================================================
#  saxbytools/saxby
#  =====================================================================
#  The same two binaries a release tarball carries, on a base with
#  nothing else: no shell, no package manager, no curl. Nothing is
#  compiled here. The build context holds one folder per platform,
#
#      linux/amd64/saxbyd   linux/amd64/saxby
#      linux/arm64/saxbyd   linux/arm64/saxby
#
#  filled from the release's tarballs by scripts/docker-context.js, so
#  the image and the tarball hold the same bytes.
#
#  Deno-compiled binaries need glibc and libgcc, which is what
#  distroless "cc" is. They run as its unprivileged user, uid 65532.

#  The data folder must exist and belong to that user before it is
#  declared a volume, and distroless has no mkdir to make it with.
#  This stage runs on the builder's own platform whatever the target
#  is, since a folder is the same on every one, so a two-platform
#  build needs no emulation.
FROM --platform=$BUILDPLATFORM busybox:1.37 AS data
RUN mkdir -p /data/saxby && chown -R 65532:65532 /data

FROM gcr.io/distroless/cc-debian12:nonroot

ARG TARGETOS
ARG TARGETARCH
ARG VERSION=unknown
ARG REVISION=unknown

LABEL org.opencontainers.image.title="Saxby" \
      org.opencontainers.image.description="A local-first LLM routing daemon" \
      org.opencontainers.image.source="https://github.com/saxby-tools/saxby" \
      org.opencontainers.image.documentation="https://github.com/saxby-tools/saxby/blob/main/docs/docker.md" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

COPY --chmod=755 ${TARGETOS}/${TARGETARCH}/saxbyd /usr/local/bin/saxbyd
COPY --chmod=755 ${TARGETOS}/${TARGETARCH}/saxby /usr/local/bin/saxby
COPY --from=data --chown=65532:65532 /data /data

#  Config, decision log, vectors and the API token live in one tree,
#  /data/saxby, so one volume holds an instance whole.
ENV XDG_CONFIG_HOME=/data
VOLUME /data

EXPOSE 11435

#  Asks saxbyd over the container's own loopback, which never needs
#  the API token.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["/usr/local/bin/saxby", "status"]

ENTRYPOINT ["/usr/local/bin/saxbyd"]
