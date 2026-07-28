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

# Update yay bin
mkdir -p /var/yay-bin
git config --global --add safe.directory /var/yay-bin
cd /var/yay-bin
if [ -e .git ]; then
	git pull origin master --depth 1
else
	git init -b master
	git remote add origin https://aur.archlinux.org/yay-bin.git
	git pull origin master
fi
chown -R makepkg:makepkg /var/yay-bin

# Install yay
sudo -u makepkg makepkg -sir --needed --noconfirm
