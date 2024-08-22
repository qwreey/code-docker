FROM archlinux

COPY --chown=root:root entrypoint.sh           /sbin/entrypoint
COPY --chown=root:root config                  /install
COPY --chown=root:root code-server-autoinstall /install/code
COPY --chown=root:root install.sh              /install/install.sh

RUN --mount=type=cache,target=/var/cache/pacman /install/install.sh
RUN mkdir /code && chsh root --shell /bin/zsh

ENTRYPOINT /sbin/entrypoint quiet loglevel=3
