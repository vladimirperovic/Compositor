// The browser's side of the filter core. The page hands over a flat array of floats instead of the
// processor's struct, so nothing in JavaScript has to know how that struct is laid out, and the two
// premultiply helpers bridge the difference between a canvas (straight alpha) and the core (premultiplied).
#include "FinishPixels.h"
#include <stdint.h>

enum { DK_SLOTS = 13, DK_MAX_EFFECTS = 32 };

static void dk_read(const float *values, FinishEffectSettings *effect) {
    effect->kind = (int)values[0];
    effect->amount = values[1];
    effect->shadows = values[2];
    effect->midtones = values[3];
    effect->highlights = values[4];
    effect->radius = values[5];
    effect->saturation = values[6];
    effect->palette = (int)values[7];
    effect->contrast_type = (int)values[8];
    effect->protect_shadows = values[9];
    effect->protect_highlights = values[10];
    effect->seed = (uint32_t)values[11];
    effect->scale = values[12];
}

int dk_apply(uint8_t *rgba, int width, int height, int full_width, int full_height,
             int offset_x, int offset_y, const float *values, int count) {
    if (!values || count < 0 || count > DK_MAX_EFFECTS || width <= 0 || height <= 0) return 0;
    FinishEffectSettings effects[DK_MAX_EFFECTS];
    for (int e = 0; e < count; ++e) dk_read(values + (size_t)e * DK_SLOTS, &effects[e]);
    return finish_apply_stack(rgba, (size_t)width, (size_t)height, (size_t)width * 4,
                              (size_t)full_width, (size_t)full_height, (size_t)offset_x, (size_t)offset_y,
                              effects, (size_t)count);
}

// The margin a crop needs around it to match the whole image, the same sum the desktop app uses.
int dk_reach(const float *values, int count) {
    if (!values || count < 0 || count > DK_MAX_EFFECTS) return 0;
    int total = 0;
    for (int e = 0; e < count; ++e) {
        FinishEffectSettings effect;
        dk_read(values + (size_t)e * DK_SLOTS, &effect);
        total += finish_effect_reach(&effect);
    }
    return total + 2;
}

int dk_is_opaque(const uint8_t *rgba, int pixels) {
    for (int i = 0; i < pixels; ++i) if (rgba[(size_t)i * 4 + 3] != 255) return 0;
    return 1;
}

void dk_premultiply(uint8_t *rgba, int pixels) {
    for (int i = 0; i < pixels; ++i) {
        uint8_t *p = rgba + (size_t)i * 4;
        unsigned a = p[3];
        for (int c = 0; c < 3; ++c) p[c] = (uint8_t)((p[c] * a + 127) / 255);
    }
}

void dk_unpremultiply(uint8_t *rgba, int pixels) {
    for (int i = 0; i < pixels; ++i) {
        uint8_t *p = rgba + (size_t)i * 4;
        unsigned a = p[3];
        if (!a) { p[0] = p[1] = p[2] = 0; continue; }
        for (int c = 0; c < 3; ++c) {
            unsigned value = (p[c] * 255u + a / 2) / a;
            p[c] = (uint8_t)(value > 255 ? 255 : value);
        }
    }
}
