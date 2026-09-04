#!/usr/bin/env bash
# Publish one generated site archive without exposing HTML before every asset it
# references is present. The uploaded archive is removed only after success, so
# an interrupted deployment can be retried with the same input.
set -euo pipefail

if [ "$#" -gt 1 ]; then
	echo 'usage: deploy-site [archive]' >&2
	exit 2
fi

archive=${1:-${ODA_SITE_ARCHIVE:-/tmp/oda-site.tgz}}
web_root=${ODA_SITE_WEB_ROOT:-/var/www/oda/public}
staging_parent=${ODA_SITE_STAGING_PARENT:-/tmp}
owner=${ODA_SITE_OWNER-www-data:www-data}

is_within() {
	candidate=$1
	parent=$2
	case "$candidate" in
		"$parent" | "$parent"/*) return 0 ;;
		*) return 1 ;;
	esac
}

case "$web_root" in
	/*) ;;
	*)
		echo 'deploy-site: web directory must be a nonempty absolute path' >&2
		exit 2
		;;
esac

# Resolve dot components and every existing symlink before this value reaches
# rsync --delete or chown -R. Validate and operate on the same spelling.
if ! resolved_web_root=$(realpath -m -- "$web_root"); then
	echo 'deploy-site: could not resolve the web directory' >&2
	exit 2
fi
case "$resolved_web_root" in
	/ | //*)
		echo 'deploy-site: refusing a filesystem-root web directory' >&2
		exit 2
		;;
esac
web_root=$resolved_web_root

if [ ! -f "$archive" ]; then
	echo "deploy-site: archive not found: $archive" >&2
	exit 1
fi

# The archive is the retry handle for an interrupted deployment. Resolve it
# once, reject a spelling inside the live delete target, and use only that
# canonical path from here through the final success-only removal.
if ! resolved_archive=$(realpath -e -- "$archive") || [ ! -f "$resolved_archive" ]; then
	echo 'deploy-site: could not resolve the archive as a regular file' >&2
	exit 1
fi
if is_within "$resolved_archive" "$web_root"; then
	echo 'deploy-site: archive must be outside the live web directory' >&2
	exit 2
fi
archive=$resolved_archive

# A source below an rsync --delete destination can delete itself and the live
# pages. Prove the configured parent is disjoint before creating anything.
if ! resolved_staging_parent=$(realpath -m -- "$staging_parent"); then
	echo 'deploy-site: could not resolve the staging directory' >&2
	exit 2
fi
if is_within "$resolved_staging_parent" "$web_root"; then
	echo 'deploy-site: staging directory must be outside the live web directory' >&2
	exit 2
fi
staging_parent=$resolved_staging_parent

mkdir -p -- "$staging_parent"
stage_candidate=$(mktemp -d "$staging_parent/oda-new.XXXXXX")
if ! resolved_stage=$(realpath -e -- "$stage_candidate"); then
	rmdir -- "$stage_candidate" 2>/dev/null || true
	echo 'deploy-site: could not resolve the staging directory created for this attempt' >&2
	exit 2
fi
if is_within "$resolved_stage" "$web_root"; then
	# Do not remove a path which resolved inside the protected live tree. The
	# directory is still empty because extraction has not started.
	echo 'deploy-site: generated staging directory overlaps the live web directory' >&2
	exit 2
fi
stage=$resolved_stage
finish() {
	status=$?
	trap - EXIT
	rm -rf -- "$stage"
	exit "$status"
}
trap finish EXIT

# Do not let an archive escape its unique staging directory. Site builds use
# ordinary forward-slash paths, so backslashes and absolute/parent components
# have no legitimate meaning here.
tar -tzf "$archive" >/dev/null
if ! LC_ALL=C tar -tvzf "$archive" | awk '
	{
		type = substr($1, 1, 1)
		if (type != "-" && type != "d") exit 1
	}
'; then
	echo 'deploy-site: archive contains a link or special file' >&2
	exit 1
fi
while IFS= read -r member; do
	case "$member" in
		/* | \\* | [A-Za-z]:* | *\\*)
			echo "deploy-site: unsafe archive member: $member" >&2
			exit 1
			;;
	esac
	IFS=/ read -r -a parts <<< "$member"
	for part in "${parts[@]}"; do
		if [ "$part" = '..' ]; then
			echo "deploy-site: unsafe archive member: $member" >&2
			exit 1
		fi
	done
done < <(tar -tzf "$archive")

tar -xzf "$archive" -C "$stage"
if find "$stage" -mindepth 1 ! -type d ! -type f -print -quit | grep -q . || \
	find "$stage" -mindepth 1 -type f -links +1 -print -quit | grep -q .; then
	echo 'deploy-site: extracted site contains a link or special file' >&2
	exit 1
fi
if [ ! -f "$stage/index.html" ] || [ ! -d "$stage/assets" ] || \
	! find "$stage/assets" -type f -print -quit | grep -q .; then
	echo 'deploy-site: archive is not a complete generated site' >&2
	exit 1
fi

mkdir -p "$web_root/assets"

# Phase one is additive: publish every content-addressed asset needed by the new
# pages while retaining assets still referenced by cached older HTML.
rsync -a -- "$stage/assets/" "$web_root/assets/"

# Phase two advances the pages and removes retired non-asset paths. The assets
# directory is protected from --delete because old hashes remain valid for
# browsers and intermediaries still holding an older page.
rsync -a --delete --exclude '/assets/***' -- "$stage/" "$web_root/"

if [ -n "$owner" ]; then
	chown -R -- "$owner" "$web_root"
fi

rm -f -- "$archive"
