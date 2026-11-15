"""The providers the service knows about.

A new model becomes available by writing a class that implements
`VocalProvider` and registering it below. Nothing else in the service — and
nothing at all in ClipForge — has to change.
"""

from __future__ import annotations

from typing import Iterable

from .base import Cancelled, ModelSpec, Report, VocalProvider
from .center_channel import CenterChannelProvider
from .demucs import DemucsProvider

_REGISTRY: dict[str, VocalProvider] = {}


def register(provider: VocalProvider) -> VocalProvider:
    """Adds a provider to the registry."""
    _REGISTRY[provider.id] = provider
    return provider


def all_providers() -> list[VocalProvider]:
    """Every known provider, in the order they are tried."""
    return list(_REGISTRY.values())


def get(provider_id: str) -> VocalProvider | None:
    return _REGISTRY.get(provider_id)


def default_provider() -> VocalProvider | None:
    """The provider a job uses when the client does not name one.

    A model is preferred over a filter: it separates far better. The first
    available model wins; a filter is the fallback.
    """
    providers = all_providers()
    for provider in providers:
        if provider.kind != "model":
            continue
        available, _ = provider.available()
        if available:
            return provider
    for provider in providers:
        available, _ = provider.available()
        if available:
            return provider
    return None


register(DemucsProvider())
register(CenterChannelProvider())

__all__ = [
    "Cancelled",
    "CenterChannelProvider",
    "DemucsProvider",
    "ModelSpec",
    "Report",
    "VocalProvider",
    "all_providers",
    "default_provider",
    "get",
    "register",
]
