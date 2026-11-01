### Fixed
- Chat's question card can move to unanswered later pi-ask questions with Next, and between omp
  Ask questions without answering. Omp moves need a complete styled tab strip and its matching
  open call; omp's review page is not a step the card moves to, and offers no moves itself.
  Unsent edits stay visible until sent or cleared.
- Before each key the card sends, a move or an answer, the server reads the terminal again and sends
  the key only if it still shows the question the card was tapped on; otherwise nothing is sent.
- An omp question cut short on screen keeps the terminal's text on the card instead of the call's
  Markdown, since what is shown may be another call's question that starts the same way.
