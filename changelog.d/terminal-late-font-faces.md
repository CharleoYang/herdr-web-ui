### Fixed
- The terminal sizes icons and Korean from the faces that draw them however their fonts arrive.
  Before, two faces arriving together (both Korean weights from the cache in Ovis for Mac's window,
  or an icon with Korean) could leave icons drawn across the next cell and Korean enlarged past its
  two cells, and one font chunk that failed to load could keep the others at the stand-in's size.
- The bundled Korean face is no longer fetched when a Korean font installed ahead of it draws the
  text, nor while a terminal font typed in Settings loads, and that font is applied without
  waiting for it.
