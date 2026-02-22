FROM archlinux

COPY --chown=root:root entrypoint.sh           /install/entrypoint
COPY --chown=root:root config                  /install
COPY --chown=root:root code-server-autoinstall /install/code
COPY --chown=root:root build.sh                /install/build.sh
COPY --chown=root:root install-yay.sh          /install/install-yay.sh
COPY --chown=root:root service.sh              /install/service.sh
COPY --chown=root:root entrypoint.sh           /sbin/entrypoint
COPY --chown=root:root bin                     /install/bin

RUN useradd --system --create-home makepkg \
    && mkdir -p /etc/sudoers.d \
    && echo "makepkg ALL=(ALL:ALL) NOPASSWD:ALL" > /etc/sudoers.d/makepkg

RUN --mount=type=cache,target=/home/makepkg --mount=type=cache,target=/var/yay-bin --mount=type=cache,target=/var/cache/pacman /install/install-yay.sh && /install/build.sh

STOPSIGNAL 15

RUN mkdir /code &&\
    chsh root --shell /bin/zsh &&\
    sed -E 's|^(root:[^:]*:[^:]*:[^:]*:[^:]*:)/root(:[^:]*)$|\1/code\2|' -i /etc/passwd &&\
    mv /etc/ssh /etc/default

ENTRYPOINT /sbin/entrypoint

