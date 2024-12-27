#!/bin/bash
set -e  # Exit on error

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo "This script should not be run with sudo."
    exit 1
fi

# Detect host OS
HOST_OS="unknown"
if [[ "$OSTYPE" == "darwin"* ]]; then
    HOST_OS="macos"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    HOST_OS="linux"
else
    echo "Unsupported operating system: $OSTYPE"
    exit 1
fi

# Check for required tools
check_requirements() {
    if [[ "$HOST_OS" == "linux" ]]; then
        if ! command -v zip &> /dev/null; then
            echo "zip is not installed. Installing..."
            sudo apt-get update && sudo apt-get install -y zip
        fi
    elif [[ "$HOST_OS" == "macos" ]]; then
        if ! command -v zip &> /dev/null; then
            echo "zip is not installed. Please install command line tools:"
            echo "xcode-select --install"
            exit 1
        fi
    fi
}

# Run requirement check
check_requirements

# CD into the directory of this script
cd "$(dirname "$0")" || exit 1

# Initialize timing
script_start_time=$(date +%s)

# Create builds directory if it doesn't exist
mkdir -p builds

# Define platforms and architectures
platforms=("mac" "win" "lin")
architectures=("arm" "x64")

# Function to convert architecture for folder name
get_arch_folder() {
    local arch=$1
    if [ "$arch" == "arm" ]; then
        echo "arm64"
    else
        echo "x64"
    fi
}

# Function to create zip file
create_zip() {
    local platform=$1
    local arch=$2
    local arch_folder=$(get_arch_folder "$arch")
    local source_dir="builds/$platform-$arch"
    local zip_name="builds/$platform-$arch.zip"

    echo "Creating $zip_name..."
    
    if [ -d "$source_dir" ]; then
        # Remove existing zip if it exists
        rm -f "$zip_name"
        
        if [ "$platform" == "mac" ]; then
            if [[ "$HOST_OS" == "macos" ]]; then
                # Use ditto on macOS for proper app bundle handling
                ditto -c -k --sequesterRsrc --keepParent \
                    "$source_dir/InstantCognition-darwin-$arch_folder/InstantCognition.app" \
                    "$zip_name"
            else
                # For Linux, use regular zip but preserve symlinks
                (cd "$source_dir/InstantCognition-darwin-$arch_folder" && \
                 zip -r -y "../../$zip_name" "InstantCognition.app")
            fi
        else
            # For other platforms, zip everything in the directory
            (cd "$source_dir" && zip -r "../../$zip_name" .)
        fi
    else
        echo "Warning: Source directory $source_dir not found"
    fi
}

# Clean up any existing builds
echo "Cleaning up old builds..."
rm -rf builds/*

# Update packages
echo "Updating packages..."
bash update_packages_latest.sh

# Build and zip for each platform/architecture combination
for platform in "${platforms[@]}"; do
    for arch in "${architectures[@]}"; do
        echo ""
        echo "Building for $platform-$arch..."
        echo ""
        
        # Build the package
        npm run package-$platform-$arch
        
        # Create zip file
        create_zip "$platform" "$arch"
    done
done

# Calculate and display execution time
end_time=$(date +%s)
execution_time=$((end_time - script_start_time))
echo ""
echo "Build completed in $(($execution_time / 60)) minutes and $(($execution_time % 60)) seconds"
echo ""
echo "Created zip files:"
ls -lh builds/*.zip
