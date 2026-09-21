// A release build is a windowed application, not a console one: without this
// Windows opens a terminal behind the window and leaves it there.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    meshnet_desktop_lib::run()
}
