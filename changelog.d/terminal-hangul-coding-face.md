### Fixed
- The terminal draws Korean in a coding face that matches its Latin text, in Ovis for Mac's window
  and in every browser: the app now carries the Hangul of D2Coding, fetched only once a pane prints
  Korean. Before, Korean fell back to the system's proportional font (Apple SD Gothic Neo on a Mac,
  Malgun Gothic on Windows) beside Menlo or Consolas. An installed Korean coding font still comes
  first where the browser can use it.
- In Safari and Ovis for Mac's window, the terminal measures Nerd Font icons again once their font
  arrives, so a late icon font no longer leaves icons sized for the stand-in font.
