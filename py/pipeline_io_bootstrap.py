"""Import first in heavy pipeline scripts to enable NAS I/O fair-share."""
import io_fairshare

io_fairshare.activate()
