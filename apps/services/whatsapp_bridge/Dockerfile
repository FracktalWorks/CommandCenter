# whatsapp_bridge — pure-Go (CGO-free) build, so a tiny static image.
FROM golang:1.24 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
# CGO off: modernc sqlite + whatsmeow are pure Go, so the binary is static.
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/whatsapp_bridge .

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /data
COPY --from=build /out/whatsapp_bridge /usr/local/bin/whatsapp_bridge
# The paired-session db lives in the mounted /data volume so it survives restarts.
ENV WHATSAPP_BRIDGE_STORE=/data/bridge-store.db
EXPOSE 8790
ENTRYPOINT ["/usr/local/bin/whatsapp_bridge"]
