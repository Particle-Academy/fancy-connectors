<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/**
 * The field NAMES a connector saw in a real response, per operation.
 *
 * Names ONLY. A recorded response body from a real account is a data leak
 * wearing a test fixture's clothes, and the thing being checked is the shape.
 */
final readonly class RecordedShape
{
    /** @param array<string,list<string>> $operations */
    public function __construct(
        public string $connector,
        public string $recordedOn,
        public array $operations,
    ) {}
}
