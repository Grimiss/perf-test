D8M4 LAYOUT DEVELOPMENT BUILD RC1

This is a separate development utility based on CP06 RC12. It does NOT replace a production checkpoint.

HOW TO USE
1. Open with VS Code Live Server as usual.
2. In the floating LAYOUT DEV panel, press EDIT OFF so it reads EDIT ON.
3. Click a physical live control on the D8M4 to select it.
4. Drag the cyan selection box to move it.
5. Drag the white square at the bottom-right to resize it.
6. Arrow keys nudge by the current Snap value. Shift+Arrow nudges 10 px.
7. Exact X/Y/W/H values use the fixed 1536 x 1024 D8M4 design coordinates.
8. Changes autosave in browser localStorage and survive refreshes.
9. COPY CSS gives percentage values for the selected control.
10. EXPORT JSON saves all changed positions in one file.
11. RESET ONE removes the selected override. RESET ALL restores the production layout.

IMPORTANT
- While EDIT is ON, normal clicking of physical controls is intentionally intercepted so you can select/move them safely.
- Turn EDIT OFF to test the machine normally.
- This first utility is for the physical live-layer controls. Dynamic CRT-internal layout editing can be added separately if useful.


RC3 NOTES
- The positions from your exported JSON have been baked into CSS as the new starting layout.
- Old browser autosaves are isolated by a new V3 storage key, so they cannot move the controls back.
- The cream backing behind BUILD YOUR DRONE / CONTROL CENTRE / USER GUIDES is now selectable as:
  #utility-panel — BUTTON BACKING PANEL
- Turn EDIT ON, choose it from the Target menu or click an exposed part of the panel, then drag/resize it like any other element.
