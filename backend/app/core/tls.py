import datetime
import ipaddress
import socket
from pathlib import Path
from typing import Tuple

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

from app.core.database import DATA_DIR, ensure_dirs

CERTS_DIR = DATA_DIR / "certs"


def ensure_self_signed_cert() -> Tuple[Path, Path]:
    """
    Generates a self-signed X.509 TLS certificate (cert.pem, key.pem) valid for 10 years
    with SubjectAlternativeName for localhost, 127.0.0.1, and local host IPs.
    """
    ensure_dirs()
    CERTS_DIR.mkdir(parents=True, exist_ok=True)
    cert_path = CERTS_DIR / "cert.pem"
    key_path = CERTS_DIR / "key.pem"

    if cert_path.is_file() and key_path.is_file():
        return cert_path, key_path

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    subject = issuer = x509.Name(
        [
            x509.NameAttribute(NameOID.COUNTRY_NAME, "BR"),
            x509.NameAttribute(NameOID.STATE_OR_PROVINCE_NAME, "PE"),
            x509.NameAttribute(NameOID.LOCALITY_NAME, "Recife"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Venosan Brasil - Firebird Command Center"),
            x509.NameAttribute(NameOID.COMMON_NAME, "firebird-command-center.venosan.local"),
        ]
    )

    san_list = [
        x509.DNSName("localhost"),
        x509.DNSName("firebird-command-center"),
        x509.DNSName("inframgnt-server"),
        x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
        x509.IPAddress(ipaddress.IPv4Address("0.0.0.0")),
    ]

    try:
        hostname = socket.gethostname()
        san_list.append(x509.DNSName(hostname))
        local_ip = socket.gethostbyname(hostname)
        san_list.append(x509.IPAddress(ipaddress.IPv4Address(local_ip)))
    except Exception:
        pass

    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(private_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.SubjectAlternativeName(san_list), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(private_key, hashes.SHA256())
    )

    key_path.write_bytes(
        private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path
