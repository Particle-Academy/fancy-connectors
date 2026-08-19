<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/** The provider rejected the credential. Retrying cannot help, and it locks accounts. */
final class ConnectorAuthException extends ConnectorException
{
    public function kind(): FailureKind
    {
        return FailureKind::Rejected;
    }
}
