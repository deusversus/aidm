"""Cryptography utilities for secure API key storage."""

import os
import base64
import hashlib
from pathlib import Path
from typing import Optional

# Try to import cryptography, fallback to basic encoding if not available
try:
    from cryptography.fernet import Fernet
    CRYPTO_AVAILABLE = True
except ImportError:
    CRYPTO_AVAILABLE = False
    Fernet = None


def get_machine_id() -> str:
    """Get a machine-specific identifier for key derivation.
    
    Uses a combination of factors to create a stable machine ID.
    Falls back to a fixed salt if platform info unavailable.
    """
    import platform
    
    factors = []
    
    # Platform info
    factors.append(platform.node())  # Computer network name
    factors.append(platform.machine())  # Machine type
    factors.append(platform.processor())  # Processor info
    
    # Windows-specific: try to get machine GUID
    try:
        import winreg
        key = winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            r"SOFTWARE\Microsoft\Cryptography",
            0,
            winreg.KEY_READ | winreg.KEY_WOW64_64KEY
        )
        machine_guid, _ = winreg.QueryValueEx(key, "MachineGuid")
        factors.append(machine_guid)
        winreg.CloseKey(key)
    except Exception:
        pass
    
    # Combine factors
    combined = "|".join(factors)
    return combined


def derive_encryption_key() -> bytes:
    """Derive a Fernet encryption key from machine-specific data.
    
    Returns:
        32-byte key suitable for Fernet encryption
    """
    machine_id = get_machine_id()
    salt = b"aidm_v3_api_key_encryption"
    
    # Use PBKDF2-like derivation
    key_material = hashlib.pbkdf2_hmac(
        'sha256',
        machine_id.encode('utf-8'),
        salt,
        iterations=100000,
        dklen=32
    )
    
    # Fernet requires URL-safe base64 encoded key
    return base64.urlsafe_b64encode(key_material)


# Global encryption key (derived once)
_encryption_key: Optional[bytes] = None


def get_fernet() -> Optional[object]:
    """Get Fernet cipher instance.
    
    Returns:
        Fernet cipher or None if cryptography not available
    """
    global _encryption_key
    
    if not CRYPTO_AVAILABLE:
        return None
    
    if _encryption_key is None:
        _encryption_key = derive_encryption_key()
    
    return Fernet(_encryption_key)


def encrypt_api_key(plaintext: str) -> str:
    """Encrypt an API key for storage.
    
    Args:
        plaintext: The plain API key
        
    Returns:
        Encrypted key as base64 string, or original if crypto unavailable
    """
    if not plaintext:
        return ""
    
    fernet = get_fernet()
    if fernet is None:
        # Fallback: basic obfuscation (NOT SECURE)
        return f"BASE64:{base64.b64encode(plaintext.encode()).decode()}"
    
    encrypted = fernet.encrypt(plaintext.encode('utf-8'))
    return f"FERNET:{encrypted.decode('utf-8')}"


def decrypt_api_key(ciphertext: str) -> str:
    """Decrypt a stored API key.
    
    Args:
        ciphertext: The encrypted key
        
    Returns:
        Decrypted API key
    """
    if not ciphertext:
        return ""
    
    # Check for encryption prefix
    if ciphertext.startswith("FERNET:"):
        fernet = get_fernet()
        if fernet is None:
            raise ValueError("Cannot decrypt: cryptography library not installed")
        
        encrypted_data = ciphertext[7:]  # Remove prefix
        try:
            decrypted = fernet.decrypt(encrypted_data.encode('utf-8'))
            return decrypted.decode('utf-8')
        except Exception as e:
            raise ValueError(f"Decryption failed: {e}")
    
    elif ciphertext.startswith("BASE64:"):
        # Fallback decoding
        encoded_data = ciphertext[7:]
        return base64.b64decode(encoded_data).decode('utf-8')
    
    else:
        # Assume plaintext (legacy or env var)
        return ciphertext


def mask_api_key(key: str) -> str:
    """Create a masked version of an API key for display.
    
    Args:
        key: The API key (can be encrypted or plain)
        
    Returns:
        Masked version like "sk-...xxxx" or "Configured" or "Not set"
    """
    if not key:
        return ""
    
    # Decrypt if needed for masking
    try:
        plain = decrypt_api_key(key)
    except Exception:
        return "[Invalid Key]"
    
    if not plain:
        return ""
    
    # Create mask
    if len(plain) <= 8:
        return "****"
    
    prefix = plain[:4] if len(plain) > 8 else plain[:2]
    suffix = plain[-4:]
    return f"{prefix}...{suffix}"


def is_key_configured(key: str) -> bool:
    """Check if a key is configured (not empty).
    
    Args:
        key: The stored key value
        
    Returns:
        True if key is set and valid
    """
    if not key:
        return False
    
    try:
        plain = decrypt_api_key(key)
        return bool(plain and len(plain) > 0)
    except Exception:
        return False
