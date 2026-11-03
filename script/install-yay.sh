#!/bin/bash
set -e

# Create makepkg user
useradd --system --create-home makepkg
mkdir -p /etc/sudoers.d
echo "makepkg ALL=(ALL:ALL) NOPASSWD:ALL" > /etc/sudoers.d/makepkg

# Install dependencies
pacman -Suy --needed --noconfirm git base-devel sudo

# Disable root error
# sed 's/if (( EUID == 0 )); then$/if false; then/g' -i /usr/bin/makepkg

# Disable debug
sed 's/^OPTIONS=.*/OPTIONS=(strip docs !libtool !staticlibs emptydirs zipman purge !debug lto)/g' -i /etc/makepkg.conf

# Update yay bin - pinned to YAY_BIN_COMMIT (Dockerfile ARG), not AUR's
# moving master: everything makepkg runs here does so as a user with
# passwordless sudo, so the PKGBUILD is root code at build time. The pin covers
# the binary too, since the PKGBUILD carries the release tarball's sha256.
: "${YAY_BIN_COMMIT:?YAY_BIN_COMMIT must name an aur.archlinux.org/yay-bin.git commit}"
mkdir -p /var/yay-bin
git config --global --add safe.directory /var/yay-bin
cd /var/yay-bin
if [ ! -e .git ]; then
	git init -b master
	git remote add origin https://aur.archlinux.org/yay-bin.git
fi
# fetch+reset, not pull: this is a persisted --mount=type=cache repo, and a
# pull fails outright on an amended/rebased upstream history. AUR serves a
# commit by its full hash even when it is no longer master's tip.
git fetch --depth 1 origin "$YAY_BIN_COMMIT"
git reset --hard FETCH_HEAD
chown -R makepkg:makepkg /var/yay-bin

# Install yay
sudo -u makepkg makepkg -sir --needed --noconfirm
