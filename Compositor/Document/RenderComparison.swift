import Foundation
import CoreGraphics

extension EditorSession {
    func setFinishComparison(_ mode: FinishComparisonMode) {
        guard let edit = filterEdit, edit.kind == .renderFinish else { return }
        edit.darkroom.comparisonMode = mode
        edit.darkroom.showingOriginal = false
        if let fill = edit.darkroom.comparisonFill { fitFinishComparison(fill: fill) }
        brushRevision += 1
    }

    func showFinishOriginal(_ show: Bool) {
        guard let edit = filterEdit, edit.kind == .renderFinish else { return }
        edit.darkroom.showingOriginal = show
        brushRevision += 1
    }

    func fitFinishComparison(fill: Bool = false) {
        guard let edit = filterEdit, edit.kind == .renderFinish, let document else { return }
        let zoom = FinishComparisonGeometry.zoom(document: document.size, view: viewport.viewSize,
            backingScale: viewport.backingScale, sideBySide: edit.darkroom.comparisonMode == .sideBySide, fill: fill)
        viewport.setZoom(zoom, anchoredAt: viewport.center, documentSize: document.size)
        viewport.pan = .zero
        edit.darkroom.comparisonFill = fill
        brushRevision += 1
    }
}

extension EditorSession {
    /// Zooming inside Darkroom: it stops following Fit or Fill, and Side by Side zooms around the pane the pointer
    /// is over rather than the gap between the panes.
    func darkroomZoomAnchor(_ anchor: CGPoint) -> CGPoint {
        guard let edit = filterEdit, edit.kind == .renderFinish else { return anchor }
        edit.darkroom.comparisonFill = nil
        guard edit.darkroom.comparisonMode == .sideBySide, anchor != viewport.center else { return anchor }
        return FinishComparisonGeometry.centeredAnchor(anchor, view: viewport.viewSize, backingScale: viewport.backingScale)
    }
}
