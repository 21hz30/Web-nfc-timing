#!/bin/sh
set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH= cd -- "$script_dir/../../.." && pwd)"
output_dir="${1:-$repo_root/deploy/aliyun/dist}"
platform="${OFFLINE_PLATFORM:-linux/amd64}"
release_tag="${OFFLINE_TAG:-aliyun-$(date -u +%Y%m%d%H%M%S)}"

if [ "$platform" != "linux/amd64" ]; then
  echo "Only linux/amd64 is supported by the current ECS bundle" >&2
  exit 1
fi

mkdir -p "$output_dir"

postgres_image="postgres:17.6-alpine"
postgrest_image="postgrest/postgrest:v14.5"
api_image="src-timing-api:$release_tag"
web_image="src-timing-web:$release_tag"

if [ "${OFFLINE_SKIP_PULL:-0}" != "1" ]; then
  docker pull --platform "$platform" "$postgres_image"
  docker pull --platform "$platform" "$postgrest_image"
fi

docker buildx build \
  --platform "$platform" \
  --load \
  --tag "$api_image" \
  --file "$repo_root/deploy/aliyun/Dockerfile.api" \
  "$repo_root"

docker buildx build \
  --platform "$platform" \
  --load \
  --tag "$web_image" \
  --file "$repo_root/deploy/aliyun/Dockerfile.web" \
  "$repo_root"

for image in "$postgres_image" "$postgrest_image" "$api_image" "$web_image"; do
  architecture="$(docker image inspect --format '{{.Architecture}}' "$image")"
  if [ "$architecture" != "amd64" ]; then
    echo "Image $image has unexpected architecture $architecture" >&2
    exit 1
  fi
done

images_archive="$output_dir/src-timing-images-linux-amd64.tar"
docker save \
  --output "$images_archive" \
  "$postgres_image" \
  "$postgrest_image" \
  "$api_image" \
  "$web_image"
gzip -f "$images_archive"

staging_dir="$(mktemp -d)"
trap 'rm -rf "$staging_dir"' EXIT

bundle_root="$staging_dir/src-counting"
mkdir -p "$bundle_root/deploy/aliyun/scripts" "$bundle_root/deploy/aliyun/postgres"
mkdir -p "$bundle_root/supabase"

cp "$repo_root/deploy/aliyun/compose.offline.yml" "$bundle_root/deploy/aliyun/"
cp "$repo_root/deploy/aliyun/env.example" "$bundle_root/deploy/aliyun/"
cp "$repo_root/deploy/aliyun/README.md" "$bundle_root/deploy/aliyun/"
printf 'IMAGE_TAG=%s\n' "$release_tag" > "$bundle_root/deploy/aliyun/release.env"
cp "$repo_root/deploy/aliyun/postgres/"*.sql "$bundle_root/deploy/aliyun/postgres/"
cp "$repo_root/deploy/aliyun/scripts/migrate.sh" "$bundle_root/deploy/aliyun/scripts/"
cp "$repo_root/deploy/aliyun/scripts/clone-data.sh" "$bundle_root/deploy/aliyun/scripts/"
cp "$repo_root/deploy/aliyun/scripts/generate-secrets.mjs" "$bundle_root/deploy/aliyun/scripts/"
cp -R "$repo_root/supabase/migrations" "$bundle_root/supabase/"

deploy_archive="$output_dir/src-timing-deploy-linux-amd64.tar.gz"
tar -C "$staging_dir" -czf "$deploy_archive" src-counting

(
  cd "$output_dir"
  shasum -a 256 \
    src-timing-images-linux-amd64.tar.gz \
    src-timing-deploy-linux-amd64.tar.gz \
    > SHA256SUMS
)

echo "Offline release $release_tag created in $output_dir"
