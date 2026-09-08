from homeassistant.const import REQUIRED_PYTHON_VER

from custom_components.webrtc_mike import *
from custom_components.webrtc_mike.config_flow import *
from custom_components.webrtc_mike.media_player import *


def test_backward():
    # https://github.com/home-assistant/core/blob/2023.2.0/homeassistant/const.py
    assert REQUIRED_PYTHON_VER >= (3, 10, 0)

    assert async_setup_entry, async_unload_entry
    assert FlowHandler
    assert WebRTCPlayer
