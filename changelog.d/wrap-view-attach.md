### Fixed
- On a phone that only watches a pane, a pane another device sized wider than the screen is no
  longer cut off on the right: it is drawn folded to the screen's width, as a Windows PC's pane is,
  and so is a pane drawn at another device's size while the phone's keyboard is up. The pane menu's
  Original width draws it at that device's width again, panned sideways. A phone that types into
  the pane still gets the program redrawn at its own width.
