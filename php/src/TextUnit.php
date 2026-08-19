<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/**
 * What a provider actually counts. Declared per connector, never guessed.
 *
 * Providers count different things — Bluesky counts graphemes, Discord and
 * Telegram count characters, some count bytes — so the choice is made explicit
 * at the point a limit is declared and nobody has to remember which network is
 * which.
 */
enum TextUnit: string
{
    /** What a person means by "a character". A family emoji is one of these. */
    case Graphemes = 'graphemes';

    /** Unicode code points, as `mb_strlen` counts them. */
    case Characters = 'characters';

    /** Raw UTF-8 bytes, as `strlen` counts them. */
    case Utf8Bytes = 'utf8-bytes';
}
