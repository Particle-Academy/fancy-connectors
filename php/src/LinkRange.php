<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/**
 * A URL found in some text, with the UTF-8 byte range it occupies.
 *
 * The generic half of a "link facet" — a connector maps these into whatever its
 * provider's rich-text shape is. The package owns the OFFSETS, because the
 * offsets are what people get wrong; it does not own the provider's schema,
 * because that is the provider's.
 */
final readonly class LinkRange extends ByteRange
{
    public function __construct(int $byteStart, int $byteEnd, public string $url)
    {
        parent::__construct($byteStart, $byteEnd);
    }
}
