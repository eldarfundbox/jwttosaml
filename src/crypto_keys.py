from datetime import datetime, timedelta, timezone
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

KEYS_DIR = Path(__file__).resolve().parent.parent / ".keys"


def get_identity_keys() -> dict[str, str]:
    """
    Generates or loads a persistent 2048-bit RSA keypair and self-signed X.509 v3
    IdP certificate using Python's `cryptography` library.
    """
    KEYS_DIR.mkdir(parents=True, exist_ok=True)

    priv_path = KEYS_DIR / "idp-private.pem"
    pub_path = KEYS_DIR / "idp-public.pem"
    cert_path = KEYS_DIR / "idp-cert.pem"

    if priv_path.exists() and pub_path.exists() and cert_path.exists():
        private_key_pem = priv_path.read_text(encoding="utf-8")
        public_key_pem = pub_path.read_text(encoding="utf-8")
        cert_pem = cert_path.read_text(encoding="utf-8")
    else:
        private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        public_key = private_key.public_key()

        subject = issuer = x509.Name(
            [x509.NameAttribute(NameOID.COMMON_NAME, "MCP-SAP-IdP")]
        )
        now = datetime.now(timezone.utc)
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(public_key)
            .serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=1))
            .not_valid_after(now + timedelta(days=365))
            .sign(private_key, hashes.SHA256())
        )

        private_key_pem = private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ).decode("utf-8")

        public_key_pem = public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ).decode("utf-8")

        cert_pem = cert.public_bytes(serialization.Encoding.PEM).decode("utf-8")

        priv_path.write_text(private_key_pem, encoding="utf-8")
        pub_path.write_text(public_key_pem, encoding="utf-8")
        cert_path.write_text(cert_pem, encoding="utf-8")

    cert_base64 = (
        cert_pem.replace("-----BEGIN CERTIFICATE-----", "")
        .replace("-----END CERTIFICATE-----", "")
        .replace("\r", "")
        .replace("\n", "")
        .strip()
    )

    return {
        "privateKeyPem": private_key_pem,
        "publicKeyPem": public_key_pem,
        "certPem": cert_pem,
        "certBase64": cert_base64,
    }

