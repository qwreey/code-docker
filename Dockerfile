FROM archlinux

COPY --chown=root:root entrypoint.sh           /install/entrypoint
COPY --chown=root:root config                  /install
COPY --chown=root:root code-server-autoinstall /install/code
COPY --chown=root:root package.sh              /install/package.sh
COPY --chown=root:root start.sh                /install/start.sh
COPY --chown=root:root entrypoint.sh           /sbin/entrypoint
COPY --chown=root:root bin                     /install/bin

RUN --mount=type=cache,target=/var/cache/pacman /install/package.sh

RUN mkdir /code &&\
    chsh root --shell /bin/zsh &&\
    sed -E 's|^(root:[^:]*:[^:]*:[^:]*:[^:]*:)/root(:[^:]*)$|\1/code\2|' -i /etc/passwd

ENTRYPOINT /sbin/entrypoint
