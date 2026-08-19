<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/** The methods a connector operation may use. */
enum HttpMethod: string
{
    case Get = 'GET';

    case Post = 'POST';

    case Put = 'PUT';

    case Patch = 'PATCH';

    case Delete = 'DELETE';
}
