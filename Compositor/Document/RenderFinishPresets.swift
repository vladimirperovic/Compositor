import Foundation
import Observation

/// A saved Render Finish look: every effect's settings, enabled or not.
nonisolated struct RenderFinishPreset: Codable, Equatable, Identifiable, Sendable {
    var id: String
    var name: String
    var settings: RenderFinishSettings
}

/// Built-in starting points for architectural renders, plus the looks the user has saved (kept in user defaults,
/// so they are available in every document).
@MainActor @Observable
final class RenderFinishPresets {
    static let shared = RenderFinishPresets()
    private(set) var saved: [RenderFinishPreset] = []
    private static let storageKey = "renderFinishPresets.v1"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.storageKey),
           let presets = try? JSONDecoder().decode([RenderFinishPreset].self, from: data) {
            saved = presets
        }
    }

    /// Saves `settings` under `name`, replacing a saved preset of the same name.
    func save(_ settings: RenderFinishSettings, named name: String) {
        let title = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
        guard !title.isEmpty else { return }
        let preset = RenderFinishPreset(id: UUID().uuidString, name: title, settings: settings.normalized)
        if let index = saved.firstIndex(where: { $0.name.localizedCaseInsensitiveCompare(title) == .orderedSame }) {
            saved[index].settings = preset.settings
        } else {
            saved.append(preset)
        }
        store()
    }

    func delete(_ preset: RenderFinishPreset) {
        saved.removeAll { $0.id == preset.id }
        store()
    }

    private func store() {
        guard let data = try? JSONEncoder().encode(saved) else { return }
        defaults.set(data, forKey: Self.storageKey)
    }

    static let builtIn: [RenderFinishPreset] = [
        look("natural-interior", "Natural Interior") {
            $0[.tonalContrast] = tonal(45, .balanced, shadows: 20, midtones: 35, highlights: 10, protectHighlights: 35)
            $0[.warmth] = warmth(60, warmth: 12, saturation: 6)
            $0[.vignette] = amount(.vignette, 15)
        },
        look("crisp-exterior", "Crisp Exterior") {
            $0[.tonalContrast] = tonal(45, .standard, shadows: 30, midtones: 45, highlights: 25,
                                       protectShadows: 20, protectHighlights: 25)
            $0[.detailExtractor] = amount(.detailExtractor, 25, radius: 4)
            $0[.proContrast] = amount(.proContrast, 35)
        },
        look("evening-glow", "Evening Glow") {
            $0[.tonalContrast] = tonal(35, .balanced, shadows: 20, midtones: 30, highlights: 10, protectHighlights: 20)
            $0[.bloom] = amount(.bloom, 35, radius: 32)
            $0[.warmth] = warmth(70, warmth: 30, saturation: 5)
            $0[.vignette] = amount(.vignette, 25)
        },
        look("soft-daylight", "Soft Daylight") {
            $0[.tonalContrast] = tonal(30, .fine, shadows: 15, midtones: 25, highlights: 5, protectHighlights: 40)
            $0[.bloom] = amount(.bloom, 15, radius: 20)
            $0[.warmth] = warmth(50, warmth: 6, saturation: 4)
        },
        look("photographic", "Photographic") {
            $0[.tonalContrast] = tonal(35, .standard, shadows: 20, midtones: 35, highlights: 10, protectHighlights: 30)
            $0[.microTexture] = amount(.microTexture, 35, radius: 1)
            $0[.highlightRolloff] = amount(.highlightRolloff, 45, radius: 18)
            $0[.lensSoftness] = amount(.lensSoftness, 30, radius: 4)
            $0[.chromaticAberration] = amount(.chromaticAberration, 100, radius: 1.5)
            $0[.vignette] = amount(.vignette, 18)
            $0[.sensorGrain] = amount(.sensorGrain, 30, radius: 1.5)
        },
        // The post chain behind the film-like CG of the late 2000s: a graded negative, warm light against
        // cool shadows, diffusion and halation through the lens, grain over all of it. One filter plays it.
        look("cinema-negative", "Cinema Negative") {
            $0[.tonalContrast] = tonal(30, .balanced, shadows: 15, midtones: 25, highlights: 5, protectHighlights: 30)
            $0[.cinematicLook] = cinematic(60, split: 65, glow: 55, grain: 35, radius: 30)
        },
        // How commercial visualization is finished instead: glare and bloom, a held-back sky, air in the
        // shadows and restrained color — and no sharpening at all, which is what gives renders away.
        look("studio-daylight", "Studio Daylight") {
            $0[.filmResponse] = film(55, lift: 20, curve: 15, shoulder: 45, saturation: -8)
            $0[.graduatedFilter] = graduated(25, from: .top, ends: 45, softness: 40, warmth: -8)
            $0[.bloom] = amount(.bloom, 30, radius: 36)
            $0[.highlightRolloff] = rolloff(35, halation: 20, radius: 24)
            $0[.vignette] = amount(.vignette, 15)
            $0[.sensorGrain] = amount(.sensorGrain, 18, radius: 1.5)
        },
        // The interior problem Corona's highlight compression exists for, solved after the render: the
        // window comes back down, borrows the shape of the wall around it and drops the clipped cast.
        look("window-light", "Window Light") {
            $0[.highlightCompensation] = recovery(75, compress: 60, borrow: 50, cast: 55, radius: 26)
            $0[.tonalContrast] = tonal(35, .balanced, shadows: 20, midtones: 30, highlights: 8, protectHighlights: 30)
            $0[.warmth] = warmth(45, warmth: 10, saturation: 4)
        },
        // Three wheels, the way a colorist would set them: cool shade, warm light, a whisper of green
        // through the middle so the whites do not go pink.
        look("colorist", "Colorist") {
            $0[.filmResponse] = film(50, lift: 18, curve: 20, shoulder: 45, saturation: 0)
            $0[.threeWayColor] = wheels(65, shadows: -35, midtones: -5, highlights: 40,
                                        tintShadows: 6, tintMidtones: -8, tintHighlights: 4)
            $0[.sensorGrain] = amount(.sensorGrain, 22, radius: 1.5)
        },
        // Dusk: the light that is left goes warm, everything it does not reach goes blue.
        look("blue-hour", "Blue Hour") {
            $0[.threeWayColor] = wheels(70, shadows: -55, midtones: -15, highlights: 45,
                                        tintShadows: -4, tintMidtones: 0, tintHighlights: 6)
            $0[.highlightRolloff] = rolloff(45, halation: 35, radius: 26)
            $0[.bloom] = amount(.bloom, 30, radius: 34)
            $0[.vignette] = amount(.vignette, 22)
            $0[.sensorGrain] = amount(.sensorGrain, 28, radius: 1.5)
        },
        // Overcast: nothing to recover, everything to lift — contrast where the light is flat, the sky
        // held down, and no grain to muddy a clean grey day.
        look("overcast-exterior", "Overcast Exterior") {
            $0[.tonalContrast] = tonal(45, .standard, shadows: 25, midtones: 40, highlights: 15, protectShadows: 15)
            $0[.proContrast] = amount(.proContrast, 40)
            $0[.graduatedFilter] = graduated(30, from: .top, ends: 40, softness: 45, warmth: -12)
            $0[.warmth] = warmth(40, warmth: 8, saturation: 6)
        },
        look("carbon-monochrome", "Carbon Monochrome") {
            $0[.tonalContrast] = tonal(40, .standard, shadows: 30, midtones: 45, highlights: 20)
            $0[.ink] = amount(.ink, 100)
            $0[.proContrast] = amount(.proContrast, 45)
            $0[.vignette] = amount(.vignette, 20)
        },
    ]

    private static func look(_ id: String, _ name: String, _ configure: (inout RenderFinishSettings) -> Void) -> RenderFinishPreset {
        var settings = RenderFinishSettings()
        for effect in FinishEffect.allCases { settings[effect].enabled = false }
        configure(&settings)
        return RenderFinishPreset(id: "builtin." + id, name: name, settings: settings.normalized)
    }
    private static func amount(_ effect: FinishEffect, _ amount: Double, radius: Double? = nil) -> FinishParameters {
        var value = effect.defaults
        value.enabled = true
        value.amount = amount
        if let radius { value.radius = radius }
        return value
    }
    private static func tonal(_ amount: Double, _ type: TonalContrastType, shadows: Double, midtones: Double, highlights: Double,
                              protectShadows: Double = 0, protectHighlights: Double = 0) -> FinishParameters {
        var value = Self.amount(.tonalContrast, amount)
        value.contrastType = type
        value.shadows = shadows; value.midtones = midtones; value.highlights = highlights
        value.protectShadows = protectShadows; value.protectHighlights = protectHighlights
        return value
    }
    private static func cinematic(_ amount: Double, split: Double, glow: Double, grain: Double,
                                  radius: Double) -> FinishParameters {
        var value = Self.amount(.cinematicLook, amount, radius: radius)
        value.shadows = split; value.midtones = glow; value.highlights = grain
        return value
    }
    private static func film(_ amount: Double, lift: Double, curve: Double, shoulder: Double,
                             saturation: Double) -> FinishParameters {
        var value = Self.amount(.filmResponse, amount)
        value.shadows = lift; value.midtones = curve; value.highlights = shoulder
        value.saturation = saturation
        return value
    }
    private static func wheels(_ amount: Double, shadows: Double, midtones: Double, highlights: Double,
                               tintShadows: Double, tintMidtones: Double, tintHighlights: Double) -> FinishParameters {
        var value = Self.amount(.threeWayColor, amount)
        value.shadows = shadows; value.midtones = midtones; value.highlights = highlights
        value.tintShadows = tintShadows; value.tintMidtones = tintMidtones; value.tintHighlights = tintHighlights
        return value
    }
    private static func recovery(_ amount: Double, compress: Double, borrow: Double, cast: Double,
                                 radius: Double) -> FinishParameters {
        var value = Self.amount(.highlightCompensation, amount, radius: radius)
        value.highlights = compress; value.shadows = borrow; value.midtones = cast
        return value
    }
    private static func rolloff(_ amount: Double, halation: Double, radius: Double) -> FinishParameters {
        var value = Self.amount(.highlightRolloff, amount, radius: radius)
        value.highlights = halation
        return value
    }
    private static func graduated(_ amount: Double, from edge: GradientEdge, ends: Double, softness: Double,
                                  warmth: Double) -> FinishParameters {
        var value = Self.amount(.graduatedFilter, amount)
        value.gradientEdge = edge
        value.highlights = ends; value.midtones = softness; value.shadows = warmth
        return value
    }
    private static func warmth(_ amount: Double, warmth: Double, saturation: Double) -> FinishParameters {
        var value = Self.amount(.warmth, amount)
        value.shadows = warmth
        value.saturation = saturation
        return value
    }
}
