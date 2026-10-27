### Fixed
- Update and restart keeps the new version when `$HOME`, or the folder Ovis keeps its state in, is
  reached through a symlink (such as `/home/<user>` linked to another volume). Before, the updated
  server went back to the old version after its restart and offered the same update again.
