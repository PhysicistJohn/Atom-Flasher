# Flasher Dev launcher

`npm run dev:install-app` installs a dedicated macOS application at
`~/Applications/Flasher Dev.app`, adds it to the Dock, and launches it.

Unlike Atomizer's dev launcher, this one does not rebuild or orchestrate
anything itself -- it only gives the Dock a correctly named, correctly
iconed entry point. Its only job when launched is to run this repo's own
`npm run dev` as a child process and forward its output to
`~/Library/Logs/Flasher Dev.log`; quitting the wrapper (or the child
exiting) stops both together.

The installed launcher records the exact Node and npm used by the installer
and prepends that Node directory to the child `PATH`. This is required because
apps opened from the macOS Dock do not inherit an NVM-initialized shell.

Rerun the installer after moving the checkout or upgrading Electron.
Ordinary application code changes do not require reinstalling.
