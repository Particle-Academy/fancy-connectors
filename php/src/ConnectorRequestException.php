<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/** A 4xx we caused. The same request will fail the same way. */
final class ConnectorRequestException extends ConnectorException
{
    public function kind(): FailureKind
    {
        return FailureKind::Rejected;
    }
}
