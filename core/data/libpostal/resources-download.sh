#!/bin/bash

set -euo pipefail

force_flag=false

# Parse command line arguments
while [[ "$#" -gt 0 ]]; do
	case $1 in
		--force) force_flag=true ;;
		*) echo "Unknown parameter passed: $1"; exit 1 ;;
	esac
	shift
done

# Check if the dictionaries directory exists
if [ -d "./dictionaries" ]; then
	if [ "$force_flag" = true ]; then
		echo "Warning: The dictionaries directory already exists. Deleting it due to --force flag."
		rm -rf "./dictionaries"
	else
		echo "Error: The dictionaries directory already exists. Please remove it first or use the --force flag."
		exit 1
	fi
fi

# Create a temporary directory
temp_dir=$(mktemp -d)

# Clone the libpostal repository into the temporary directory
git clone --depth 1 https://github.com/openvenues/libpostal.git "$temp_dir/libpostal"

# Alphabetize the contents of each file in the dictionaries directory inside the clone
for file in "$temp_dir/libpostal/resources/dictionaries/"*; do
	if [ -f "$file" ]; then
		sort "$file" -o "$file"
	fi
done

# Copy the dictionaries directory from the cloned repository
cp -r "$temp_dir/libpostal/resources/dictionaries" .

# Remove the temporary directory
rm -rf "$temp_dir"
